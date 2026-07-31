/* Hikari — renderer application logic (screen-based shell). */
'use strict';

/* ———————————————————— state ———————————————————— */
let library = [];
let currentView = 'all';           // 'all' | 'airing' | 'dubbed'
let detailId = null;               // library record (franchise root) on the detail screen
let viewId = null;                 // franchise member currently viewed on that screen
const peekCache = new Map();       // media id -> slim record for non-library seasons
let sortMode = 'airdate';          // 'airdate' | 'added' | 'title' | 'score'
let filterText = '';
const genreFilter = new Set();     // empty = all genres
const tagFilter = new Set();       // empty = all tags; combines with genres as AND
const sourceFilter = new Set();    // empty = all sources ('Local files' included)
let sourceModalShowId = null;
/* Which shelf dropdown is open. Held in state rather than only in the DOM:
   the template always renders these `hidden`, so a patch would slam an open
   dropdown shut the moment any re-render landed. */
let openDd = null;
let selectedBrand = null;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const shelfScreen = $('#screen-shelf');
const detailScreen = $('#screen-detail');
let appSettings = {};

/* ———————————————————— helpers ———————————————————— */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const FORMAT_LABEL = {
  TV: 'TV', TV_SHORT: 'TV SHORT', MOVIE: 'MOVIE', SPECIAL: 'SPECIAL',
  OVA: 'OVA', ONA: 'ONA', MUSIC: 'MUSIC'
};
const STATUS_LABEL = {
  RELEASING: 'AIRING', FINISHED: 'FINISHED', NOT_YET_RELEASED: 'UPCOMING',
  CANCELLED: 'CANCELLED', HIATUS: 'ON HIATUS'
};
const RELATION_LABEL = {
  PREQUEL: 'Prequel', SEQUEL: 'Sequel', SIDE_STORY: 'Side story',
  SPIN_OFF: 'Spin-off', ALTERNATIVE: 'Alt', SUMMARY: 'Summary', PARENT: 'Parent'
};
const VIEW_LABEL = {
  all: 'Library', airing: 'Airing now', dubbed: 'English dub', unwatched: 'Unwatched',
  favourites: 'Favourites', discover: 'Discover', announce: 'Announcements',
  browse: 'Browse'
};

const BRANDS = [
  { name: 'Netflix', color: '#E50914' },
  { name: 'Crunchyroll', color: '#F47521' },
  { name: 'Disney+', color: '#0063E5' },
  { name: 'Prime Video', color: '#00A8E1' },
  { name: 'Hulu', color: '#1CE783' },
  { name: 'HIDIVE', color: '#00AEEF' },
  { name: 'YouTube', color: '#FF0000' },
  { name: 'Other', color: '#857E72' }
];

function brandColor(name) {
  const n = String(name || '').toLowerCase();
  const hit = BRANDS.find((b) => b.name !== 'Other' && n.includes(b.name.toLowerCase()));
  if (hit) return hit.color;
  if (n.includes('disney')) return '#0063E5';
  if (n.includes('amazon') || n.includes('prime')) return '#00A8E1';
  return '#857E72';
}

const fmtFormat = (f) => FORMAT_LABEL[f] || f || '';
const fmtStatus = (s) => STATUS_LABEL[s] || s || '';

/* readable text color for a brand background */
function brandText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#14120F' : '#fff';
}

function fmtAiring(next) {
  if (!next) return '';
  const secs = next.airingAt - Math.floor(Date.now() / 1000);
  if (secs <= 0) return `EP ${next.episode} OUT NOW`;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const when = d > 0 ? `${d}D ${h}H` : h > 0 ? `${h}H ${m}M` : `${m}M`;
  return `EP ${next.episode} IN ${when}`;
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'err' ? 'err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function persist() {
  groupsVer++; // any mutation invalidates the franchise-group cache
  window.hikari.saveLibrary(library).catch(() => toast('Could not save library', 'err'));
}

/* ———————————————————— shell chrome ———————————————————— */
/* ambient: the current artwork blurred under everything (ghost) */
let ambCur = '';
let ambFlip = false;
function setAmbient(url) {
  if (!url || url === ambCur) return;
  ambCur = url;
  const nxt = $(ambFlip ? '#amb-a' : '#amb-b');
  const old = $(ambFlip ? '#amb-b' : '#amb-a');
  ambFlip = !ambFlip;
  nxt.onload = () => { nxt.classList.add('on'); old.classList.remove('on'); };
  nxt.src = url;
}
function tickClock() {
  const el = $('#sb-clock');
  if (el) el.textContent = new Date().toTimeString().slice(0, 5);
}

function updateChrome() {
  const airing = library.filter(showIsAiring).length;
  const shows = groupEntries(library).length;
  $('#pill-count').textContent = `${shows} SHOW${shows === 1 ? '' : 'S'}`;
  $('#live-dot').classList.toggle('idle', airing === 0);
  $('#sb-shows').textContent = shows;
  $('#sb-airing').textContent = airing;
  const badge = $('#nav-air-badge');
  if (badge) { badge.hidden = airing === 0; badge.textContent = airing; }

  /* Announcements badge counts only what has a real date attached — an
     undated "confirmed for 2027" is not news you need a number for. */
  const annBadge = $('#nav-ann-badge');
  if (annBadge) {
    const soon = announcements().filter((r) => r.at || r.month).length;
    annBadge.hidden = soon === 0;
    annBadge.textContent = soon;
  }

  if (detailScreen.classList.contains('active')) {
    const v = getViewRecord();
    $('#crumb-text').textContent = v ? v.title : 'Hikari';
    $('#crumb-sub').textContent = '— details';
  } else {
    $('#crumb-text').textContent = 'Hikari';
    const bits = [`${shows} show${shows === 1 ? '' : 's'}`];
    if (airing) bits.push(`${airing} airing`);
    $('#crumb-sub').textContent = `— ${currentView === 'all' ? bits.join(' · ') : (VIEW_LABEL[currentView] || currentView).toLowerCase()}`;
  }
}

const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let morphId = null;

/* clear any stray shared-element names so each snapshot has a unique one */
function clearMorphNames() {
  $$('.ac-cover, .rel-cover, .dh-poster').forEach((e) => {
    if (e.style.viewTransitionName) e.style.viewTransitionName = '';
  });
}
/* tag the element the morph should fly to/from in the NEW snapshot */
function tagMorph() {
  clearMorphNames();
  if (morphId == null) return;
  if (detailScreen.classList.contains('active')) {
    const p = $('.dh-poster', detailScreen);
    if (p) p.style.viewTransitionName = 'hero-poster';
  } else {
    const c = $(`.anime-card[data-id="${morphId}"] .ac-cover`, shelfScreen);
    if (c) c.style.viewTransitionName = 'hero-poster';
  }
}
/* ———————————————————— screen patching ————————————————————
   The shelf and detail screens used to be rebuilt with `innerHTML = …`. Since
   sync.js re-renders on every realtime echo from the phone, that meant:

     · the caret was yanked out of the filter box mid-word (measured: after a
       re-render the input is a NEW node and document.activeElement is body);
     · the shelf scrolled back to the top — renderShelf never preserved
       scrollTop, which is why five separate call sites had grown their own
       manual save/restore around renderDetail;
     · every visible card replayed its .55s `cardin` entry animation, so the
       whole grid flashed each time an episode was ticked on the phone;
     · open dropdowns (genres/tags/sources) snapped shut.

   Patching the DOM instead touches only what actually differs. Cards carry
   data-key so the reconcile matches by identity rather than index.

   NB: this is only safe because render functions attach NO per-render
   listeners — everything else goes through the delegated data-action handler.
   Anything added later must be delegated too, or it will bind twice. */
const _scratch = document.createElement('div');
const MORPH_OPTS = {
  getNodeKey: (n) => (n.nodeType === 1 ? (n.dataset && n.dataset.key) || n.id || undefined : undefined),
  onBeforeElUpdated(from, to) {
    if (from.isEqualNode(to)) return false;                 // whole subtree unchanged
    /* never rewrite the field being typed into, or a <video> mid-playback */
    if (from === document.activeElement && /^(INPUT|TEXTAREA)$/.test(from.tagName)) return false;
    if (from.tagName === 'VIDEO') return false;
    return true;
  },
  onBeforeNodeDiscarded(node) {
    if (node.nodeType === 1 && node.contains(document.activeElement)
      && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return false;
    return true;
  }
};
/* replace an element's CONTENTS (innerHTML semantics) */
function patchHTML(el, html) {
  if (!el) return;
  if (typeof morphdom !== 'function') { el.innerHTML = html; return; }
  _scratch.innerHTML = html;
  morphdom(el, _scratch, { ...MORPH_OPTS, childrenOnly: true });
  _scratch.textContent = '';
}
/* replace the element ITSELF (outerHTML semantics) */
function patchOuter(el, html) {
  if (!el) return;
  if (typeof morphdom !== 'function') { el.outerHTML = html; return; }
  morphdom(el, html, MORPH_OPTS);
}

function withTransition(fn) {
  if (REDUCE_MOTION || !document.startViewTransition) { fn(); return; }
  try { document.startViewTransition(fn); } catch { fn(); }
}
function showScreen(name) {
  const target = name === 'detail' ? detailScreen : shelfScreen;
  const other = name === 'detail' ? shelfScreen : detailScreen;
  other.classList.remove('active');
  target.classList.add('active');
  /* .screen has scroll-behavior:smooth, so a plain scrollTop=0 ANIMATES back
     from wherever the screen was left — firing scroll events the whole way,
     which re-collapsed the sticky bar on a freshly opened show. Jump instead. */
  target.style.scrollBehavior = 'auto';
  target.scrollTop = 0;
  target.style.scrollBehavior = '';
  detailScreen.classList.remove('stuck');
  updateChrome();
}

function goShelf() {
  withTransition(() => { renderShelf(); showScreen('shelf'); tagMorph(); });
}

/* Which season the detail screen opens on. Not "whichever member happens to
   be the shelf record" — if you shelved a franchise by way of a later season
   or a film, that would drop you into season 4 of a show you never started.
   Open where you are actually up to: the first season with anything left,
   else season 1. */
function initialViewFor(rootId) {
  const root = library.find((x) => x.id === rootId);
  if (!root) return rootId;
  const seasons = foldedSeasons(seasonEntriesOf(root.franchise, root.id));
  if (!seasons.length) return rootId;
  const g = groupEntries(library).find((grp) => grp.members.some((m) => m.id === rootId));
  const watchedIn = (id) => {
    const rec = g?.members.find((m) => m.id === id) || (root.id === id ? root : null);
    return rec ? Object.values(rec.watched || {}).reduce((a, l) => a + l.length, 0) : 0;
  };
  for (const se of seasons) {
    for (const p of se.parts) {
      const total = p.episodes || 0;
      if (!total || watchedIn(p.id) < total) return p.id;    // still something to watch
    }
  }
  return seasons[0].parts[0].id;                             // all done — start at the top
}
function goDetail(id) {
  morphId = id;
  detailId = id;
  const want = initialViewFor(id);
  /* A season we don't own needs its peek record before it can be shown, and
     renderDetail falls back to the root without one. Show the root instantly,
     then switch once it lands — never make the page wait on a fetch. */
  viewId = peekCache.has(want) ? want : id;
  withTransition(() => { renderDetail(); showScreen('detail'); tagMorph(); });
  if (want !== viewId) {
    fetchPeek(want)
      .then(() => {                       // guard: they may have opened something else meanwhile
        if (detailId !== id || !detailScreen.classList.contains('active')) return;
        viewId = want;
        const st = detailScreen.scrollTop;
        renderDetail();
        detailScreen.scrollTop = st;
      })
      .catch(() => { /* stay on the root */ });
  }

  /* stale show? bring it up to date quietly while it's on screen */
  const root = library.find((x) => x.id === id);
  if (root && isStale(root)) {
    refreshRoot(root).then(() => {
      if (detailId === id && detailScreen.classList.contains('active')) {
        const st = detailScreen.scrollTop;
        renderDetail();
        detailScreen.scrollTop = st;
      }
    }).catch(() => {});
  }
}

/* ———————————————————— shelf ———————————————————— */
/* ——— franchise grouping ———
   Entries whose franchise graphs overlap are one "show" on the shelf. */
const XMARK = icon('x');

function franchiseIds(s) {
  const ids = new Set([s.id]);
  (s.franchise || []).forEach((f) => ids.add(f.id));
  return ids;
}
function setsIntersect(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}
function pickRep(members) {
  return [...members].sort((a, b) => {
    const at = ['TV', 'TV_SHORT'].includes(a.format) ? 0 : 1;
    const bt = ['TV', 'TV_SHORT'].includes(b.format) ? 0 : 1;
    if (at !== bt) return at - bt;                       // a TV season leads
    const ay = a.year || 9999, by = b.year || 9999;
    if (ay !== by) return ay - by;                       // then the earliest
    return (b.popularity || 0) - (a.popularity || 0);
  })[0];
}
/* ═══════════════════════════════════════════════════════════════════════
   SHOWS AND FRANCHISES
   Ported from the rules validated against a live AniList crawl of 132 media
   across Fate, Hunter x Hunter, Fullmetal Alchemist, Attack on Titan, Code
   Geass, Steins;Gate, Demon Slayer and Mushoku Tensei. Each rule exists
   because one of those broke without it.

   A SHOW is one continuity. A FRANCHISE is the family of shows that share a
   source. Unlimited Blade Works is a different SHOW from Fate/stay night in
   the same FRANCHISE — not its fourth season.

   Needs `rel` on franchise entries (frv 3). Records below that fall back to
   the old behaviour rather than guessing.  */
const FR_ACCESSORY = new Set(['MOVIE', 'OVA', 'SPECIAL', 'MUSIC']);
const FR_SERIES = new Set(['TV', 'TV_SHORT', 'ONA']);
/* 3 = relation types; 4 = English-first titles with the vouched-synonym
   fallback. Bumping this re-walks every franchise once, in the background. */
const FRV_RELATIONS = 4;

/** Do we hold relation types for this record's franchise? */
function hasRelations(rec) {
  return (rec?.frv || 0) >= FRV_RELATIONS && (rec.franchise || []).some((f) => Array.isArray(f.rel));
}

/**
 * Partition a franchise's entries into shows. Returns Map<entryId, showId>,
 * where showId is the id of that show's earliest TV entry.
 */
function showMapFor(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const parent = new Map(entries.map((e) => [e.id, e.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const key = (a, b) => (a < b ? a + ':' + b : b + ':' + a);
  const alt = new Set();
  /* what follows on FROM x, and what x follows on from — both directions are
     needed, because a branch can appear at either end. */
  const cont = new Map(entries.map((e) => [e.id, new Set()]));
  const from = new Map(entries.map((e) => [e.id, new Set()]));
  for (const e of entries) {
    for (const [other, r] of e.rel || []) {
      if (!byId.has(other)) continue;
      if (r === 'ALTERNATIVE') alt.add(key(e.id, other));
      /* AniList stores these from whichever side it feels like — Fate/Zero S2
         lists no sequels, yet both Fate/stay night and UBW name it as their
         prequel. Normalise both directions into one pair of maps. */
      if (r === 'SEQUEL') { cont.get(e.id).add(other); from.get(other)?.add(e.id); }
      if (r === 'PREQUEL') { cont.get(other)?.add(e.id); from.get(e.id).add(other); }
    }
  }
  /* Rivals are two full SERIES. A film that is ALTERNATIVE to a TV arc is a
     recut of it (Demon Slayer's Mugen Train) — not a competing adaptation. */
  const rivals = (a, b) => alt.has(key(a, b))
    && FR_SERIES.has(byId.get(a)?.format) && FR_SERIES.has(byId.get(b)?.format);
  /* A branch has two shapes and BOTH have to be caught.

     DIVERGENCE — one work continues into two rivals. Fate/Zero leads into both
     Fate/stay night and Unlimited Blade Works, which are rival adaptations, so
     the three are separate shows.

     CONVERGENCE — one work continues FROM two rivals. UQ Holder! is the sequel
     to Negima! (2005) AND to Negima!? (2006), which are rival adaptations of
     the same manga. Only checking divergence missed this entirely: each Negima
     has a single sequel, so nothing looked forked, and UQ Holder merged with
     both — dragging in three "seasons", a pile of films and a show called
     Negima that has nothing to do with what you added. */
  const forked = new Set();      // diverges: do not merge its continuations
  const converged = new Set();   // converges: do not merge its sources
  const hasRivalPair = (ids) => {
    const a = [...ids];
    for (let i = 0; i < a.length; i++)
      for (let j = i + 1; j < a.length; j++)
        if (rivals(a[i], a[j])) return true;
    return false;
  };
  for (const [x, ys] of cont) if (hasRivalPair(ys)) forked.add(x);
  for (const [x, ys] of from) if (hasRivalPair(ys)) converged.add(x);

  for (const e of entries) {
    for (const [other, r] of e.rel || []) {
      if (!byId.has(other)) continue;
      if (r === 'SUMMARY') { union(e.id, other); continue; }
      /* e -SEQUEL-> other : blocked if e diverges, or if `other` converges */
      if (r === 'SEQUEL') { if (!forked.has(e.id) && !converged.has(other)) union(e.id, other); continue; }
      /* e -PREQUEL-> other : blocked if `other` diverges, or if e converges */
      if (r === 'PREQUEL') { if (!forked.has(other) && !converged.has(e.id)) union(e.id, other); continue; }
      /* A side story that is itself a series is its own show — otherwise
         Steins;Gate swallows ChaöS;HEAd and Robotics;Notes. An OVA or film
         genuinely belongs to its parent. */
      if (r === 'SIDE_STORY' || r === 'PARENT') {
        if (FR_ACCESSORY.has(e.format) || FR_ACCESSORY.has(byId.get(other).format)) union(e.id, other);
      }
      /* ALTERNATIVE and SPIN_OFF never merge — that is the franchise layer. */
    }
  }

  const members = new Map();
  for (const e of entries) {
    const root = find(e.id);
    (members.get(root) || members.set(root, []).get(root)).push(e);
  }
  const out = new Map();
  for (const group of members.values()) {
    const tv = group.filter((e) => e.format === 'TV' || e.format === 'TV_SHORT');
    const pool = tv.length ? tv : group;
    const primary = [...pool].sort((a, b) => (a.sort || 0) - (b.sort || 0) || (a.year || 9999) - (b.year || 9999))[0];
    for (const e of group) out.set(e.id, primary.id);
  }
  return out;
}

/** The show a record belongs to, as a stable id. */
function showIdOf(rec) {
  if (!hasRelations(rec)) return null;
  const map = showMapFor(rec.franchise);
  return map.get(rec.id) ?? null;
}

/** Every show in this record's franchise: [{ primaryId, entries }]. */
function franchiseShows(rec) {
  if (!hasRelations(rec)) return [];
  const map = showMapFor(rec.franchise);
  const by = new Map();
  for (const e of rec.franchise) {
    const sid = map.get(e.id);
    if (sid == null) continue;
    (by.get(sid) || by.set(sid, []).get(sid)).push(e);
  }
  return [...by.entries()]
    .map(([primaryId, entries]) => ({
      primaryId,
      entries: entries.sort((a, b) => (a.sort || 0) - (b.sort || 0)),
      rep: entries.find((e) => e.id === primaryId) || entries[0]
    }))
    .sort((a, b) => (a.rep.sort || 0) - (b.rep.sort || 0));
}

/* grouping is O(n²) over the shelf and gets called several times per render —
   memoise the whole-library case (invalidated by persist()) */
let groupsVer = 0;
const groupsCache = { ver: -1, ref: null, groups: null };
function groupEntries(entries) {
  if (entries === library && groupsCache.ver === groupsVer && groupsCache.ref === library) {
    return groupsCache.groups;
  }
  const groups = computeGroups(entries);
  if (entries === library) {
    groupsCache.ver = groupsVer;
    groupsCache.ref = library;
    groupsCache.groups = groups;
  }
  return groups;
}
function computeGroups(entries) {
  /* Records that know their relation types group by SHOW: two records merge
     only when they are the same continuity. Everything else falls back to the
     old franchise-overlap merge, so a library that hasn't been re-walked yet
     behaves exactly as it did before rather than shuffling itself. */
  const shelved = [];
  const byShow = new Map();
  for (const rec of entries) {
    const sid = showIdOf(rec);
    if (sid == null) { shelved.push(rec); continue; }
    (byShow.get(sid) || byShow.set(sid, []).get(sid)).push(rec);
  }
  const showGroups = [...byShow.values()].map((members) => ({
    members, ids: new Set(members.map((m) => m.id)), rep: pickRep(members)
  }));
  if (!shelved.length) return showGroups;

  const groups = shelved.map((s) => ({ members: [s], ids: franchiseIds(s) }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (setsIntersect(groups[i].ids, groups[j].ids)) {
          groups[j].ids.forEach((x) => groups[i].ids.add(x));
          groups[i].members.push(...groups[j].members);
          groups.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  groups.forEach((g) => { g.rep = pickRep(g.members); });
  return [...showGroups, ...groups];
}
function sortGroups(groups) {
  const g = [...groups];
  const maxOf = (grp, key) => Math.max(...grp.members.map((m) => m[key] || 0));
  if (sortMode === 'title') g.sort((a, b) => a.rep.title.localeCompare(b.rep.title));
  else if (sortMode === 'score') g.sort((a, b) => maxOf(b, 'score') - maxOf(a, 'score'));
  else if (sortMode === 'added') g.sort((a, b) => maxOf(b, 'addedAt') - maxOf(a, 'addedAt'));
  /* what you actually reach for on a library you're watching: most recently
     ticked first, with never-watched shows falling to the back by air date */
  else if (sortMode === 'recent') {
    g.sort((a, b) => maxOf(b, 'lastWatchedAt') - maxOf(a, 'lastWatchedAt')
      || (b.rep.year || 0) - (a.rep.year || 0)
      || a.rep.title.localeCompare(b.rep.title));
  }
  else g.sort((a, b) => (b.rep.year || 0) - (a.rep.year || 0) || a.rep.title.localeCompare(b.rep.title)); // airdate
  return g;
}

/* Is a franchise entry a proper season? Format alone lies — AniList marks
   web-distributed seasons ONA (Rent-a-Girlfriend S4/S5) and unaired ones
   have no format at all, so season-shaped titles count too. */
function isSeasonEntry(x) {
  if (['TV', 'TV_SHORT'].includes(x.format)) return true;
  if (['MOVIE', 'SPECIAL', 'MUSIC'].includes(x.format)) return false;
  return /(?:^|\s)(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season)(?:\s*(?:part|cour)\s*\d+)?\s*$/i
    .test(x.title || '');
}

/* ——— source filter (user sources + local files) ——— */
const LOCAL_SRC = 'Local files';
function canonicalSource(name) {
  const n = String(name || '').toLowerCase();
  const hit = BRANDS.find((b) => b.name !== 'Other' && n.includes(b.name.toLowerCase()));
  if (hit) return hit.name;
  if (n.includes('disney')) return 'Disney+';
  if (n.includes('amazon') || n.includes('prime')) return 'Prime Video';
  return 'Other';
}
function recordSources(s) {
  const out = new Set((s.sources || []).map((x) => canonicalSource(x.name)));
  if (s.local?.map && countLocalEps(s.local.map) > 0) out.add(LOCAL_SRC);
  return out;
}

/* Crunchyroll / HIDIVE in the official links become the show's sources
   automatically — no manual "+ Add source" step for the platforms he uses.
   Local files always outrank sources at click time, so this only sets where
   streaming clicks land. */
const AUTO_SOURCES = ['Crunchyroll', 'HIDIVE'];
function autoAdoptSources(rec) {
  if ((rec.sources || []).length) return false;
  const links = rec.streamingLinks || [];
  const adopted = [];
  for (const want of AUTO_SOURCES) {
    const hit = links.find((l) => canonicalSource(l.site) === want);
    if (hit) adopted.push({ name: want, url: hit.url });
  }
  if (!adopted.length) return false;
  rec.sources = adopted;
  return true;
}
function sourceIndex() {
  const counts = new Map();
  for (const g of groupEntries(library)) {
    const set = new Set(g.members.flatMap((m) => [...recordSources(m)]));
    for (const src of set) counts.set(src, (counts.get(src) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) =>
    (a[0] === LOCAL_SRC ? -1 : b[0] === LOCAL_SRC ? 1 : a[0].localeCompare(b[0])));
}
function sourceChipsHTML() {
  if (!sourceFilter.size) return '';
  return `<div class="gsel-chips">
    ${[...sourceFilter].sort().map((s) => `
      <button class="gchip" data-action="src-opt" data-src="${esc(s)}" title="Remove">${esc(s)} ×</button>`).join('')}
    <button class="gclear" data-action="src-clear">Clear</button>
  </div>`;
}

/* genres and tags are separate filters now: genres = AniList's fixed list,
   tags = the long-tail taxonomy (Harem, Isekai…). Both dropdowns carry
   show (group) counts; tags need 2+ shows to earn a row. */
function genreIndex() {
  const counts = new Map();
  for (const g of groupEntries(library)) {
    for (const genre of new Set(g.members.flatMap((m) => m.genres || []))) {
      counts.set(genre, (counts.get(genre) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
function tagIndex() {
  const counts = new Map();
  for (const g of groupEntries(library)) {
    for (const tag of new Set(g.members.flatMap((m) => m.tags || []))) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/* a show counts as airing if ANY of it is — the root, a loaded season peek,
   or a franchise entry AniList marks RELEASING (root status alone lies for
   franchises whose current season isn't the library record) */
function showIsAiring(root) {
  if (root.status === 'RELEASING') return true;
  if (Object.values(root.peek || {}).some((p) => p.status === 'RELEASING')) return true;
  return (root.franchise || []).some((f) => f.status === 'RELEASING');
}

/* entries surviving the active view + filter (grouping happens after) */
function viewFiltered() {
  let list = [...library];
  if (currentView === 'airing') list = list.filter(showIsAiring);
  if (currentView === 'dubbed') list = list.filter((s) => (s.dubLanguages || []).includes('English'));
  if (currentView === 'favourites') list = list.filter((s) => s.favourite);
  /* Lives here rather than in shelfGridHTML so the headline count, the grid
     and every other consumer agree — the count used to read the unfiltered
     library ("Unwatched · 174 SHOWS" above a grid of 139). */
  if (currentView === 'unwatched') {
    list = list.filter((s) => {
      const p = showProgress(s);
      return !(p.total > 0 && p.done >= p.total);
    });
  }
  if (filterText) {
    const q = filterText.toLowerCase();
    list = list.filter((s) =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.romaji || '').toLowerCase().includes(q) ||
      (s.native || '').includes(filterText)
    );
  }
  if (genreFilter.size) {
    list = list.filter((s) => (s.genres || []).some((g) => genreFilter.has(g)));
  }
  if (tagFilter.size) {
    list = list.filter((s) => (s.tags || []).some((t) => tagFilter.has(t)));
  }
  if (sourceFilter.size) {
    list = list.filter((s) => [...recordSources(s)].some((x) => sourceFilter.has(x)));
  }
  return list;
}

function cardHTML(g, i) {
  const s = g.rep;
  const dubbed = g.members.some((m) => (m.dubLanguages || []).includes('English'));
  const hasLocal = g.members.some((m) => m.local?.map && countLocalEps(m.local.map) > 0);
  const meta = [fmtFormat(s.format), s.year, s.episodes ? `${s.episodes} EP` : ''].filter(Boolean).join(' · ');
  const ids = g.members.map((m) => m.id).join(',');
  const prog = showProgress(s);
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
  const famCount = franchiseShows(s).length;
  const complete = prog.total > 0 && prog.done >= prog.total;
  return `
  <article class="anime-card" data-key="card-${s.id}" data-action="open-show" data-id="${s.id}"
    style="--show:${esc(s.coverColor || '#E4A15D')};animation-delay:${Math.min(i, 16) * 30}ms">
    <div class="ac-cover">
      <img src="${esc(s.artCover || s.cover)}" alt="" loading="lazy" decoding="async">
      <div class="ac-shade"></div>
      ${s.score ? `<span class="ac-score">★ ${(s.score / 10).toFixed(1)}</span>` : ''}
      <span class="ac-badges">
        ${g.members.some((m) => m.favourite) ? `<span class="ac-fav" title="Favourite">${icon('heart-fill')}</span>` : ''}
        ${complete ? `<span class="ac-done" title="Watched">✓</span>` : ''}
        ${dubbed ? `<span class="ac-dub push" title="English dub">DUB</span>` : ''}
        ${hasLocal ? `<span class="ac-local ${dubbed ? '' : 'push'}" title="On disk">LOCAL</span>` : ''}
      </span>
      <button class="ac-menu" data-action="card-menu" data-group="${ids}" title="Options">${icon('dots-three')}</button>
      ${famCount > 1 ? `<button class="ac-family" data-action="open-family" data-id="${s.id}"
          title="${famCount} shows in this franchise">${icon('share-network')}<i>${famCount}</i></button>` : ''}
    </div>
    <div class="ac-meta">
      <h3>${esc(s.title)}</h3>
      <p class="meta"><span class="cdot"></span><span class="mtxt">${esc(meta)}</span></p>
      ${!complete && pct > 0 ? `<span class="ac-underline"><i style="width:${pct}%"></i></span>` : ''}
    </div>
  </article>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   THE BILLBOARD
   One slide was only ever a shop window for the last thing added. It is now a
   deck — and, more usefully, each view supplies its OWN reason for a show to
   be up there: the library shows what you added last, favourites what you
   starred, the calendar what airs next, announcements what is coming. Same
   component, different question, so the header always relates to the page
   underneath it.
   ═══════════════════════════════════════════════════════════════════════ */
const BB_MAX = 10;
const BB_DWELL = 7000;
let bbIndex = 0;
let bbTimer = null;
let bbKey = '';   // deck identity — the position resets only when the deck really changes

/** Everything airing next, newest-first, shared by the rail and the deck. */
function airingEntries() {
  const seen = new Set();
  const out = [];
  for (const g of groupEntries(library)) {
    for (const m of g.members) {
      for (const c of [m, ...Object.values(m.peek || {})]) {
        if (c.status !== 'RELEASING' || !c.nextAiring?.airingAt || seen.has(c.id)) continue;
        seen.add(c.id);
        out.push({ group: g, ep: c.nextAiring.episode, at: c.nextAiring.airingAt * 1000, airing: c.nextAiring });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** [{ rep, members, eyebrow }] — whatever this particular view is about. */
function billboardSlides() {
  const byAdded = (a, b) =>
    Math.max(...b.members.map((m) => m.addedAt || 0)) - Math.max(...a.members.map((m) => m.addedAt || 0));
  const groups = groupEntries(library);
  if (!groups.length) return [];

  if (currentView === 'announce') {
    return announcements().filter((r) => r.at || r.month).slice(0, BB_MAX).map((r) => {
      const w = annWhen(r);
      return {
        rep: { id: r.id, title: r.title, cover: r.cover, banner: '', native: '',
               description: r.forShow.description, format: r.format, year: r.year,
               coverColor: r.forShow.coverColor },
        members: [r.forShow],
        eyebrow: `${w.big} — ${w.small.toUpperCase()}`,
        goId: r.forShow.id
      };
    });
  }
  if (currentView === 'airing') {
    const seen = new Set();
    return airingEntries()
      .filter((e) => (seen.has(e.group.rep.id) ? false : (seen.add(e.group.rep.id), true)))
      .slice(0, BB_MAX)
      .map((e) => ({ rep: e.group.rep, members: e.group.members,
                     eyebrow: `NEXT UP — ${fmtAiring(e.airing)}` }));
  }
  if (currentView === 'favourites') {
    return groups.filter((g) => g.members.some((m) => m.favourite)).sort(byAdded)
      .slice(0, BB_MAX).map((g) => ({ rep: g.rep, members: g.members, eyebrow: 'A FAVOURITE' }));
  }
  if (currentView === 'unwatched') {
    return groups.filter((g) => showProgress(g.rep).done === 0).sort(byAdded)
      .slice(0, BB_MAX).map((g) => ({ rep: g.rep, members: g.members, eyebrow: 'NOT STARTED YET' }));
  }
  if (currentView === 'dubbed') {
    return groups.filter((g) => g.members.some((m) => (m.dubLanguages || []).includes('English')))
      .sort(byAdded).slice(0, BB_MAX)
      .map((g) => ({ rep: g.rep, members: g.members, eyebrow: 'ENGLISH DUB' }));
  }

  if (currentView === 'discover') {
    /* the picks themselves — a recommendation you have not seen is a far
       better reason to give something the header than anything you own */
    const picks = (typeof visibleDiscover === 'function' ? visibleDiscover() : []).slice(0, BB_MAX);
    return picks.map((e) => {
      const m = e.media;
      return {
        rep: { id: m.id, title: m.title?.english || m.title?.romaji || '?', cover: m.coverImage?.large || '',
               banner: m.bannerImage || '', native: '', description: m.description || '',
               format: m.format || '', year: m.seasonYear || null, score: m.averageScore || null,
               coverColor: m.coverImage?.color || '' },
        members: [{ score: m.averageScore || 0, dubLanguages: [] }],
        /* `because` is a Set of the shows that recommended it — name the
           first, and count the rest rather than printing "[object Set]" */
        eyebrow: (() => {
          const src = [...(e.because || [])];
          if (!src.length) return 'RECOMMENDED FOR YOU';
          const more = src.length > 1 ? ` +${src.length - 1} MORE` : '';
          return `BECAUSE YOU WATCHED ${String(src[0]).toUpperCase()}${more}`;
        })(),
        goId: m.id
      };
    });
  }

  /* the library: the ten most recently added */
  return groups.sort(byAdded).slice(0, BB_MAX).map((g) => {
    const airingM = g.members.find((m) => m.status === 'RELEASING' && m.nextAiring);
    const prog = showProgress(g.rep);
    const left = prog.total - prog.done;
    return {
      rep: g.rep, members: g.members,
      eyebrow: airingM ? `NOW AIRING — ${fmtAiring(airingM.nextAiring)}`
        : (prog.total && prog.done > 0 && prog.done < prog.total)
          ? `CONTINUE WATCHING — ${left} EPISODE${left === 1 ? '' : 'S'} LEFT`
          : 'RECENTLY ADDED'
    };
  });
}

function slideHTML(sl, i) {
  const rep = sl.rep;
  const art = hiRes(rep.artBanner
    || rep.artPool?.banners?.[0]
    || sl.members.find((m) => m.id === rep.id && m.banner)?.banner
    || sl.members.find((m) => m.banner)?.banner) || rep.cover;
  const prog = showProgress(rep);
  const nx = nextUp(rep);
  const best = Math.max(0, ...sl.members.map((m) => m.score || 0));
  const dubbed = sl.members.some((m) => (m.dubLanguages || []).includes('English'));
  const meta = [
    sl.members.length > 1 ? `${sl.members.length} TITLES` : fmtFormat(rep.format),
    rep.year,
    best ? `★ <b>${(best / 10).toFixed(1)}</b>` : '',
    dubbed ? '<b>EN DUB</b>' : ''
  ].filter(Boolean).join(' · ');
  const synopsis = cleanSynopsis(rep.description || '').split('\n')[0];
  /* An announcement slide is about something that has not aired, so a play
     glyph and the word "Open" promise what does not exist. Checking
     rep.status is no good — the rep is the OWNED parent show (Black Clover,
     FINISHED); it is the announced entry that is unreleased. */
  const unreleased = currentView === 'announce' || rep.status === 'NOT_YET_RELEASED';
  const resume = unreleased
    ? 'View show'
    : nx && prog.done > 0
      ? `▶&nbsp; Resume · ${nx.seasons > 1 ? `S${nx.season} ` : ''}E${nx.ep}`
      : '▶&nbsp; Open';
  return `
  <div class="bb-slide${i === bbIndex ? ' on' : ''}" data-slide="${i}"
       data-action="open-show" data-id="${sl.goId || rep.id}"
       style="--show:${esc(rep.coverColor || '#E4A15D')}">
    <div class="bb-artwrap">
      <img class="bb-art" src="${esc(art)}" alt=""${i === 0 ? '' : ' loading="lazy"'}>
      <div class="bb-wash"></div>
    </div>
    <div class="bb-body">
      <p class="bb-eyebrow">${sl.eyebrow}</p>
      <h2 class="bb-title">${esc(rep.title)}</h2>
      ${rep.native ? `<p class="bb-jp">${esc(rep.native)}</p>` : ''}
      <p class="bb-meta">${meta}</p>
      ${synopsis ? `<p class="bb-desc">${esc(synopsis)}</p>` : ''}
      <div class="bb-btns">
        <span class="bb-open">${resume}</span>
        <span class="bb-ghostbtn">Details</span>
      </div>
    </div>
  </div>`;
}

function billboardHTML() {
  const slides = billboardSlides().filter((sl) => sl && sl.rep);
  if (!slides.length) return '';
  /* Reset the position only when the DECK changes, not on every re-render —
     otherwise ticking an episode would throw you back to slide one. */
  const key = `${currentView}:${slides.map((sl) => sl.rep.id).join(',')}`;
  if (key !== bbKey) { bbKey = key; bbIndex = 0; }
  if (bbIndex >= slides.length) bbIndex = 0;
  return `
  <div class="billboard" data-key="billboard" data-count="${slides.length}">
    ${slides.map(slideHTML).join('')}
    ${slides.length > 1 ? `
    <button class="bb-nav prev" data-action="bb-step" data-dir="-1" aria-label="Previous">${CHEV_L}</button>
    <button class="bb-nav next" data-action="bb-step" data-dir="1" aria-label="Next">${CHEV_R}</button>
    <div class="bb-dots">
      ${slides.map((_, i) => `<button class="bb-dot${i === bbIndex ? ' on' : ''}" data-action="bb-go" data-i="${i}" aria-label="Slide ${i + 1}"></button>`).join('')}
    </div>` : ''}
  </div>`;
}

/* Changing slide toggles two classes. It must never re-render the shelf —
   rebuilding 200 cards to advance a carousel is exactly the kind of work this
   app cannot afford. */
function bbShow(next) {
  const bb = $('.billboard', shelfScreen);
  if (!bb) return;
  const slides = [...bb.querySelectorAll('.bb-slide')];
  if (slides.length < 2) return;
  bbIndex = (next + slides.length) % slides.length;
  slides.forEach((el, i) => el.classList.toggle('on', i === bbIndex));
  bb.querySelectorAll('.bb-dot').forEach((el, i) => el.classList.toggle('on', i === bbIndex));
  const art = slides[bbIndex].querySelector('.bb-art');
  if (art) setAmbient(art.src);
  bbRestart();
}
function bbRestart() {
  clearInterval(bbTimer);
  const bb = $('.billboard', shelfScreen);
  if (!bb || bb.querySelectorAll('.bb-slide').length < 2) return;
  bbTimer = setInterval(() => {
    const live = $('.billboard', shelfScreen);
    /* never advance under the pointer, off-screen, or while reading */
    if (!live || document.hidden || live.matches(':hover')) return;
    bbShow(bbIndex + 1);
  }, BB_DWELL);
}

/* ghost: everything airing this week as one compact rail on the home view */
function airRailHTML() {
  if (currentView !== 'all') return '';
  const seen = new Set();
  const entries = [];
  for (const g of groupEntries(viewFiltered())) {
    for (const m of g.members) {
      for (const c of [m, ...Object.values(m.peek || {})]) {
        if (c.status !== 'RELEASING' || !c.nextAiring?.airingAt || seen.has(c.id)) continue;
        seen.add(c.id);
        const lbl = seasonDisplay(g, c);
        entries.push({
          rootId: g.rep.id, mediaId: c.id,
          title: lbl.season ? `${lbl.name}` : c.title, season: lbl.season,
          cover: c.cover || g.rep.cover,
          ep: c.nextAiring.episode, at: c.nextAiring.airingAt * 1000,
          dub: recHasDub(c)
        });
      }
    }
  }
  if (!entries.length) return '';
  entries.sort((a, b) => a.at - b.at);
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const when = (e) => {
    if (e.at <= Date.now()) return '<b class="now">OUT NOW</b>';
    const d = new Date(e.at);
    const dd = Math.floor((e.at - Date.now()) / 86400e3);
    return `<b>${DOW[d.getDay()]} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b> · ${dd ? `${dd}d` : 'today'}`;
  };
  /* the same information, split at a place we chose rather than wherever the
     text happened to run out of room */
  const whenParts = (e) => {
    if (e.at <= Date.now()) return { slot: `EP ${e.ep}`, rel: '<b class="now">OUT NOW</b>' };
    const d = new Date(e.at);
    const dd = Math.floor((e.at - Date.now()) / 86400e3);
    return {
      slot: `EP ${e.ep} · <b>${DOW[d.getDay()]} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>`,
      rel: dd ? `in ${dd}d` : 'today'
    };
  };
  return `
  <div class="air-rail-sec">
    <h3 class="sh">On air <span class="cnt">${entries.length} BROADCAST${entries.length === 1 ? '' : 'S'} THIS WEEK</span></h3>
    ${railHTML(entries.slice(0, 14).map((e) => `
      <button class="air-tile" data-action="open-show" data-id="${e.rootId}" data-media="${e.mediaId}">
        <img src="${esc(e.cover)}" alt="" loading="lazy" decoding="async">
        <span class="att">
          <b>${e.season ? `<i class="ct-s">S${e.season}</i> ` : ''}${esc(e.title)}</b>
          <small class="at-when">${whenParts(e).slot}</small>
          <small class="at-in">${whenParts(e).rel}${e.dub ? '<i class="at-dub">DUB</i>' : ''}</small>
        </span>
      </button>`).join(''))}
  </div>`;
}

function shelfGridHTML() {
  const groups = sortGroups(groupEntries(viewFiltered()));
  return groups.length
    ? `<div class="grid">${groups.map(cardHTML).join('')}</div>`
    : emptyHTML();
}

/* ——— continue watching ——— */
function orderedSeasons(root) {
  /* same reason: a spin-off is not a season of this show, so it must not
     appear in continue-watching or collect local files as one */
  const fr = seasonEntriesOf(root.franchise || [], root.id).filter(isSeasonEntry);
  return fr.length ? fr : [{ id: root.id, episodes: root.episodes || root.episodesList?.length || 0, title: root.title }];
}
/* the first unwatched episode across the show's seasons, in watch order */
function nextUp(root) {
  const seasons = orderedSeasons(root);
  for (let i = 0; i < seasons.length; i++) {
    const total = seasons[i].episodes || 0;
    if (!total) continue;
    const seen = new Set(watchedList(root, seasons[i].id));
    for (let n = 1; n <= total; n++) {
      if (!seen.has(n)) return { season: i + 1, ep: n, seasons: seasons.length };
    }
  }
  return null;
}
function continueRailHTML() {
  if (currentView !== 'all') return '';
  const rows = groupEntries(library).map((g) => {
    const p = showProgress(g.rep);
    if (!(p.done > 0 && p.total > 0 && p.done < p.total)) return null;
    const nx = nextUp(g.rep);
    if (!nx) return null;
    return { g, p, nx, at: g.rep.lastWatchedAt || g.rep.addedAt || 0 };
  }).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, 10);
  if (!rows.length) return '';
  return `
  <div class="cw-sec">
    <h3 class="sh">Continue watching <span class="cnt">${rows.length} SHOW${rows.length === 1 ? '' : 'S'}</span></h3>
    ${railHTML(rows.map(({ g, p, nx }) => `
      <button class="cw-card" data-action="open-show" data-id="${g.rep.id}" style="--show:${esc(g.rep.coverColor || '#E4A15D')}">
        <img src="${esc(g.rep.artCover || g.rep.cover)}" alt="" loading="lazy" decoding="async">
        <span class="cw-body">
          <b>${esc(g.rep.title)}</b>
          <span class="cw-next">NEXT UP · ${nx.seasons > 1 ? `S${nx.season} ` : ''}E${nx.ep}</span>
          <span class="cw-bar"><i style="width:${Math.round((p.done / p.total) * 100)}%"></i></span>
        </span>
      </button>`).join(''))}
  </div>`;
}

/* ——— season folding ———
   AniList splits cours into separate entries ("Part 2", "Cour 2"), so Mushoku
   Tensei looks like 5 seasons when the world (and Crunchyroll) counts 3.
   Fold consecutive TV entries whose titles differ only by a part marker into
   one season. TV_SHORT spin-offs (Break Time etc.) stay their own thing. */
/* Only the entries that belong to THIS show may be numbered.

   The Slime Diaries is a TV series and a SPIN_OFF of Slime, so numbering
   every TV entry made it "Season 3" and pushed the real Season 3 to 4 and
   Season 4 to 5. Once relation types are present we already know which
   entries form the continuity, so use that and let spin-offs and rival
   adaptations fall out of the season list entirely. */
function seasonEntriesOf(fr, rootId) {
  const list = fr || [];
  if (!list.some((f) => Array.isArray(f.rel))) return list;   // pre-frv-4: unchanged
  const map = showMapFor(list);
  const mine = map.get(rootId);
  if (mine == null) return list;
  return list.filter((f) => map.get(f.id) === mine);
}

function foldedSeasons(fr) {
  const strip = (t) => normTitle(String(t || '').replace(/\s*[-–—:·]?\s*(?:part|cour)\s*\d+\s*$/i, ''));
  const out = [];
  for (const f of (fr || []).filter(isSeasonEntry)) {
    const key = strip(f.title);
    /* an explicit "Part N" folds into its base season even when a spin-off
       (Re:ZERO's Break Time shorts) aired in between */
    const isPart = /(?:part|cour)\s*\d+\s*$/i.test(f.title || '');
    if (isPart && f.format === 'TV') {
      const home = [...out].reverse().find((se) => se.key === key && se.format === 'TV');
      if (home) { home.parts.push(f); continue; }
    }
    out.push({ key, format: f.format, parts: [f] });
  }
  let n = 0;
  for (const se of out) se.num = se.format === 'TV' ? ++n : null;
  return out;
}

/* "The show" for a franchise: season 1 as this app already numbers it, so the
   answer always matches the season pills. Picking a franchise entry out of
   search is easy to get wrong — Fate/stay night's search results are mostly
   Unlimited Blade Works — and landing on season 4 of something you meant to
   start is never what was wanted. Everything else in the franchise is one tap
   away in the watch order regardless. */
function franchisePrimary(fr, fallback = null) {
  return foldedSeasons(fr)[0]?.parts?.[0] || fallback;
}

/* the folded season number for a media id — what the pills show, what
   Crunchyroll calls it. Spin-offs keep their own title, no chip. */
function seasonDisplay(g, c) {
  const owner = g.members.find((m) => (m.franchise || []).some((f) => f.id === c.id)) || g.rep;
  const folded = foldedSeasons(seasonEntriesOf(owner.franchise, owner.id));
  const se = folded.find((x) => x.parts.some((p) => p.id === c.id));
  if (se?.num && folded.filter((x) => x.num).length > 1) return { name: g.rep.title, season: se.num };
  return { name: c.title, season: null };
}

function calendarHTML() {
  /* one item per airing MEDIA, carrying both its sub and dub events */
  const items = [];
  const seenMedia = new Set();
  for (const g of groupEntries(viewFiltered())) {
    for (const m of g.members) {
      for (const c of [m, ...Object.values(m.peek || {})]) {
        if (c.status !== 'RELEASING' || seenMedia.has(c.id)) continue;
        seenMedia.add(c.id);
        const it = { rootId: g.rep.id, mediaId: c.id, cover: c.cover || g.rep.cover, ...seasonDisplay(g, c) };
        if (c.nextAiring?.airingAt) { it.subEp = c.nextAiring.episode; it.subAt = c.nextAiring.airingAt * 1000; }
        const di = dubInfo(c);
        if (di?.nextAt) { it.dubEp = di.nextEp; it.dubAt = di.nextAt; }
        if (it.subAt || it.dubAt) items.push(it);
      }
    }
  }
  if (!items.length) return '';
  const total = items.reduce((a, it) => a + (it.subAt ? 1 : 0) + (it.dubAt ? 1 : 0), 0);

  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  const byDay = new Map(days.map((d) => [dayKey(d), new Map()]));
  const later = new Map();
  /* same show, same day → ONE tile with a sub line and a dub line */
  const slot = (bucket, it) => {
    let t = bucket.get(it.mediaId);
    if (!t) { t = { ...it, lines: [], first: Infinity }; bucket.set(it.mediaId, t); }
    return t;
  };
  for (const it of items) {
    for (const [dub, at, ep] of [[false, it.subAt, it.subEp], [true, it.dubAt, it.dubEp]]) {
      if (!at) continue;
      const k = dayKey(new Date(at));
      const t = slot(byDay.has(k) ? byDay.get(k) : later, it);
      t.lines.push({ dub, at, ep });
      t.first = Math.min(t.first, at);
    }
  }

  const fmtT = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtD = (ms) => new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
  const line = (l, dated) => `
    <small class="ct-line ${l.dub ? 'isdub' : ''}">
      ${l.dub ? '<i class="ct-dub">DUB</i>' : '<i class="ct-sub">EP</i>'}
      <b>${l.dub ? `EP ${l.ep}` : l.ep}</b>
      <span class="${!dated && l.at <= Date.now() ? 'now' : ''}">${dated ? fmtD(l.at) : (l.at <= Date.now() ? 'OUT NOW' : fmtT(l.at))}</span>
    </small>`;
  const tile = (t, dated) => `
    <button class="cal-tile" data-action="open-show" data-id="${t.rootId}" data-media="${t.mediaId}">
      <img src="${esc(t.cover)}" alt="" loading="lazy" decoding="async">
      <span class="ctx">
        <span class="ct-top">${t.season ? `<i class="ct-s">S${t.season}</i>` : ''}<b>${esc(t.name)}</b></span>
        ${t.lines.sort((a, b) => a.dub - b.dub || a.at - b.at).map((l) => line(l, dated)).join('')}
      </span>
    </button>`;
  const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const laterTiles = [...later.values()].sort((a, b) => a.first - b.first).slice(0, 8);
  return `
  <div class="cal-sec">
    <h3 class="sh">This week <span class="cnt">${total} BROADCAST${total === 1 ? '' : 'S'}</span></h3>
    <div class="cal">
      ${days.map((d, i) => {
        const tiles = [...byDay.get(dayKey(d)).values()].sort((a, b) => a.first - b.first);
        return `
        <div class="cal-day ${i === 0 ? 'today' : ''}">
          <p class="cal-head"><span>${i === 0 ? 'TODAY' : DOW[d.getDay()]}</span><b>${d.getDate()}</b></p>
          ${tiles.length ? tiles.map((t) => tile(t, false)).join('') : '<p class="cal-none">—</p>'}
        </div>`;
      }).join('')}
    </div>
    ${laterTiles.length ? `<div class="cal-later">
      <p class="cal-head"><span>LATER</span></p>
      <div class="cal-later-row">${laterTiles.map((t) => tile(t, true)).join('')}</div>
    </div>` : ''}
  </div>`;
}

/* airing seasons the franchise graph knows about but we've never loaded —
   fetch their records so the calendar gets air times (a few per visit) */
const airingPeekAttempted = new Set();
function upgradeAiringPeeks() {
  const wanted = [];
  for (const root of library) {
    for (const f of root.franchise || []) {
      if (f.status !== 'RELEASING') continue;
      if (f.id === root.id || peekCache.has(f.id) || root.peek?.[f.id]) continue;
      if (airingPeekAttempted.has(f.id)) continue;
      wanted.push({ root, id: f.id });
    }
  }
  if (!wanted.length) return;
  (async () => {
    let fetched = false;
    for (const { root, id } of wanted.slice(0, 4)) {
      airingPeekAttempted.add(id);
      try {
        const rec = slimRecord(await enrichShow(id, { franchise: false }));
        peekCache.set(id, rec);
        root.peek = root.peek || {};
        root.peek[id] = rec;
        fetched = true;
      } catch { /* next visit */ }
    }
    if (!fetched) return;
    persist();
    if (currentView === 'airing' && shelfScreen.classList.contains('active')) renderShelf();
  })();
}

/* ——— discover: community recommendations driven by the shelf ——— */

let discoverBusy = false;
/* the whole scored pool lives in memory — refresh pages through it instantly,
   genre chips filter it, only the FIRST visit talks to AniList */
const DISC_CAP = 100;
let discoverPool = null;   // every scored pick, best first
let discSeen = new Set();  // ids already shown this session (refresh rotates past them)
let discGenre = new Set(); // active genre filter

async function buildDiscover() {
  if (discoverBusy || discoverPool) return;
  discoverBusy = true;
  try {
    const roots = [...library];
    const recMap = await fetchRecommendations(roots.map((r) => r.id));
    const onShelf = new Set();
    for (const r of roots) franchiseIds(r).forEach((id) => onShelf.add(id));
    const weight = (root) => {
      if (root.favourite) return 2;
      const p = showProgress(root);
      if (p.total && p.done >= p.total) return 1.5;
      return p.done > 0 ? 1.2 : 1;
    };
    const agg = new Map();
    for (const root of roots) {
      const w = weight(root);
      for (const node of recMap.get(root.id) || []) {
        const m = node.mediaRecommendation;
        if (onShelf.has(m.id) || ['MUSIC', 'SPECIAL'].includes(m.format)) continue;
        const e = agg.get(m.id) || { media: m, pts: 0, because: new Set() };
        e.pts += Math.max(node.rating || 0, 1) * w;
        e.because.add(root.title);
        agg.set(m.id, e);
      }
    }
    discoverPool = [...agg.values()]
      .map((e) => ({ ...e, score: e.pts * (1 + 0.35 * (e.because.size - 1)) }))
      .sort((a, b) => b.score - a.score);
  } finally {
    discoverBusy = false;
  }
}

function visibleDiscover() {
  if (!discoverPool) return [];
  return discoverPool
    .filter((e) => !discSeen.has(e.media.id))
    .filter((e) => !discGenre.size || (e.media.genres || []).some((g) => discGenre.has(g)))
    .slice(0, DISC_CAP);
}

/* ——— discover preview: look before you add ——— */
const discPreviewCache = new Map();
const discModal = () => $('#discModal');

async function openDiscPreview(mediaId) {
  const e = (discoverPool || []).find((x) => x.media.id === mediaId);
  const m = e?.media;
  const modal = discModal();
  const body = $('#discBody');
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('on'));
  body.innerHTML = `
    <div class="dp-hero skel"></div>
    <div class="dp-body">
      <h2>${esc(m?.title.english || m?.title.romaji || '…')}</h2>
      <p class="dp-loading"><span class="spinner"></span> FETCHING DETAILS…</p>
    </div>`;
  let rec = discPreviewCache.get(mediaId);
  if (!rec) {
    try {
      rec = await enrichShowBase(mediaId);
      discPreviewCache.set(mediaId, rec);
    } catch (err) {
      if (!modal.hidden) body.querySelector('.dp-loading').textContent = `COULD NOT LOAD — ${err.message.toUpperCase()}`;
      return;
    }
  }
  if (modal.hidden) return; // closed while loading
  const dub = (rec.dubLanguages || []).includes('English');
  const because = e ? [...e.because].slice(0, 3).join('  ·  ') : '';
  const syn = cleanSynopsis(rec.description);
  body.innerHTML = `
    <div class="dp-hero">${rec.banner ? `<img src="${esc(hiRes(rec.banner))}" alt="">` : (rec.cover ? `<img class="blur" src="${esc(rec.cover)}" alt="">` : '')}
      <div class="dp-shade"></div>
      <img class="dp-poster" src="${esc(rec.cover)}" alt="">
    </div>
    <div class="dp-body">
      <h2>${esc(rec.title)}</h2>
      ${rec.native ? `<p class="dp-jp">${esc(rec.native)}</p>` : ''}
      <div class="dp-meta">
        ${rec.score ? `<span class="dp-chip star">★ ${(rec.score / 10).toFixed(1)}</span>` : ''}
        <span class="dp-chip">${esc([fmtFormat(rec.format), rec.year, rec.episodes ? `${rec.episodes} EP` : ''].filter(Boolean).join(' · '))}</span>
        ${(rec.genres || []).slice(0, 4).map((g) => `<span class="dp-chip">${esc(g)}</span>`).join('')}
        ${dub ? '<span class="dp-chip dub">EN DUB</span>' : ''}
      </div>
      ${syn ? `<p class="dp-syn">${esc(syn)}</p>` : ''}
      ${because ? `<p class="dp-because">BECAUSE YOU WATCHED ${esc(because)}</p>` : ''}
      <div class="dp-actions">
        <button class="btn-primary" data-action="disc-add" data-id="${rec.id}">+ Add to shelf</button>
        <button class="btn-ghost" data-action="disc-details" data-id="${rec.id}">Details</button>
        ${rec.siteUrl ? `<button class="btn-ghost" data-action="open-url" data-url="${esc(rec.siteUrl)}">AniList ↗</button>` : ''}
        <button class="btn-ghost" data-action="disc-close">Close</button>
      </div>
    </div>`;
}
function closeDiscPreview() {
  const modal = discModal();
  modal.classList.remove('on');
  setTimeout(() => { modal.hidden = true; }, 200);
}

/* dub badges arrive as a lazy second pass over whatever's on screen */
let discDubBusy = false;
function ensureDiscDubs() {
  if (discDubBusy || !discoverPool) return;
  const need = visibleDiscover().filter((e) => e.dub === undefined).map((e) => e.media.id);
  if (!need.length) return;
  discDubBusy = true;
  fetchDubFlags(need).then((flags) => {
    for (const e of discoverPool) {
      if (flags.has(e.media.id)) e.dub = flags.get(e.media.id);
    }
    if (currentView === 'discover' && shelfScreen.classList.contains('active')) renderDiscover();
  }).catch(() => {}).finally(() => { discDubBusy = false; });
}
function discCardHTML(e, i) {
  const m = e.media;
  const title = m.title.english || m.title.romaji || m.title.native || '';
  const because = [...e.because].slice(0, 2).join('  ·  ');
  const meta = [fmtFormat(m.format), m.seasonYear, m.averageScore ? `★ ${(m.averageScore / 10).toFixed(1)}` : '']
    .filter(Boolean).join(' · ');
  return `
  <article class="anime-card disc" data-action="disc-view" data-id="${m.id}"
    style="--show:${esc(m.coverImage?.color || '#E4A15D')};animation-delay:${Math.min(i, 16) * 30}ms">
    <div class="ac-cover">
      <img src="${esc(m.coverImage?.large || '')}" alt="" loading="lazy" decoding="async">
      <div class="ac-shade"></div>
      ${m.averageScore ? `<span class="ac-score">★ ${(m.averageScore / 10).toFixed(1)}</span>` : ''}
      <span class="ac-badges">${e.dub ? '<span class="ac-dub push">DUB</span>' : ''}</span>
      <button class="disc-add" data-action="disc-add" data-id="${m.id}" title="Add without opening">+ ADD</button>
    </div>
    <div class="ac-meta">
      <h3>${esc(title)}</h3>
      <p class="meta">${esc(meta)}</p>
      <p class="because" title="${esc([...e.because].join('  ·  '))}">BECAUSE YOU WATCHED ${esc(because)}</p>
    </div>
  </article>`;
}
function discGenreChipsHTML() {
  if (!discoverPool) return '';
  const counts = new Map();
  for (const e of discoverPool.filter((x) => !discSeen.has(x.media.id))) {
    for (const g of e.media.genres || []) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  if (!top.length) return '';
  return `
  <div class="disc-genres">
    <button class="chip ${discGenre.size ? '' : 'on'}" data-action="disc-genre-clear">All</button>
    ${top.map(([g, n]) => `
    <button class="chip ${discGenre.has(g) ? 'on' : ''}" data-action="disc-genre" data-genre="${esc(g)}">${esc(g)}<small>${n}</small></button>`).join('')}
  </div>`;
}

function renderDiscover() {
  const items = visibleDiscover();
  const fresh = discoverPool ? discoverPool.filter((e) => !discSeen.has(e.media.id)).length : 0;
  shelfScreen.innerHTML = `
    ${billboardHTML()}
    <div class="shelf-pad">
    <header class="shelf-head">
      <h1 class="display">Discover<em>.</em></h1>
      ${library.length && discoverPool ? `<div class="shelf-tools">
        <span class="disc-count">${items.length} OF ${fresh} PICKS${discSeen.size ? ` · ${discSeen.size} SEEN` : ''}</span>
        <button class="btn-ghost" data-action="disc-refresh">Next picks →</button>
      </div>` : ''}
    </header>
    ${discGenreChipsHTML()}
    ${!library.length
      ? `<div class="empty-wrap"><div class="empty-panel"><h2>Add shows first</h2>
         <p>Discover builds picks from what's on your shelf — community recommendations, weighted by your favourites.</p></div></div>`
      : !discoverPool
        ? `<p class="disc-note"><span class="spinner"></span> ASKING THE COMMUNITY WHAT PAIRS WITH YOUR SHELF…</p>
           <div class="grid">${Array.from({ length: 12 }, () =>
             '<div class="anime-card"><div class="ac-cover skel"></div></div>').join('')}</div>`
        : items.length
          ? `<p class="disc-note">Community picks driven by your shelf — favourites and finished shows count double. Click to add.</p>
             <div class="grid">${items.map(discCardHTML).join('')}</div>`
          : `<div class="empty-wrap"><div class="empty-panel"><h2>Nothing ${discGenre.size ? 'in these genres' : 'left'}</h2>
             <p>${discGenre.size ? 'Clear the genre filter or refresh for the next tier of picks.' : 'You have seen every pick — refresh to start from the top again.'}</p></div></div>`}
    </div>
  `;
  updateChrome();
  if (library.length && !discoverPool) {
    buildDiscover()
      .then(() => {
        if (currentView === 'discover') renderDiscover();
        ensureDiscDubs();
      })
      .catch((err) => {
        if (currentView === 'discover') {
          const note = $('.disc-note');
          if (note) note.innerHTML = `Could not build picks — ${esc(err.message)}`;
        }
      });
  } else {
    ensureDiscDubs();
  }
}

/* mark every TV season of a show watched (or clear everything) */
function markAllSeasons(root, watch) {
  const seasons = (root.franchise || []).filter(isSeasonEntry);
  const items = seasons.length ? seasons : [{ id: root.id, episodes: root.episodes || root.episodesList?.length || 0 }];
  for (const it of items) {
    if (!watch) { watchedMap(root)[it.id] = []; continue; }
    const total = it.episodes
      || (it.id === root.id ? epCount(root) : epCount(peekCache.get(it.id)));
    if (total) watchedMap(root)[it.id] = Array.from({ length: total }, (_, k) => k + 1);
  }
  if (!watch) for (const key of Object.keys(watchedMap(root))) watchedMap(root)[key] = [];
  root.lastWatchedAt = Date.now();
  persist();
}

function removeGroup(ids) {
  window.syncUI?.deleted?.(ids);
  library = library.filter((x) => !ids.includes(x.id));
  persist();
  renderShelf();
  toast(ids.length > 1 ? `Removed ${ids.length} titles from your shelf` : 'Removed from your shelf');
}

/* ——— card ⋯ menu ——— */
function closeCardMenu() {
  $('.cmenu')?.remove();
}

/* ── franchise overlay ─────────────────────────────────────────────────────
   Grouping hides the family: with the two-layer model, Unlimited Blade Works
   is its own card and you can no longer see from the shelf that Fate/Zero and
   Heaven's Feel exist at all. This opens OVER the grid, anchored to the card
   that spawned it, so nothing below reflows — 206 cards relaying out to open a
   panel is exactly the kind of work this app cannot afford. */
let familyEl = null;
function closeFamily() {
  if (!familyEl) return;
  familyEl.classList.remove('on');
  const el = familyEl; familyEl = null;
  setTimeout(() => el.remove(), 200);
}
function openFamily(cardEl, rootId) {
  closeFamily();
  const rec = library.find((x) => x.id === rootId);
  if (!rec) return;
  const shows = franchiseShows(rec);
  if (shows.length < 2) return;
  /* "Owned" means there is a RECORD for that show. franchiseIds() would say
     yes for every entry in the family — which is the whole set — so nothing
     would ever look addable and the panel would be pointless. */
  const ownedShowIds = new Set(library.map((r) => showIdOf(r)).filter((x) => x != null));
  const ownedRecordIds = new Set(library.map((r) => r.id));

  const rows = shows.map((sh) => {
    const e = sh.rep;
    const owned = ownedShowIds.has(sh.primaryId)
      || sh.entries.some((x) => ownedRecordIds.has(x.id));
    const eps = sh.entries.filter((x) => x.format === 'TV' || x.format === 'TV_SHORT').length;
    const meta = [e.year, fmtFormat(e.format), eps > 1 ? `${eps} seasons` : (e.episodes ? `${e.episodes} EP` : '')]
      .filter(Boolean).join(' · ');
    return `
    <button class="fam-row ${owned ? 'owned' : ''}" data-action="${owned ? 'family-open' : 'family-add'}" data-id="${e.id}">
      <span class="fam-cover">${e.cover ? `<img src="${esc(e.cover)}" alt="" loading="lazy">` : ''}</span>
      <span class="fam-info">
        <span class="fam-title">${esc(e.title || '')}</span>
        <span class="fam-meta">${esc(meta)}</span>
      </span>
      <span class="fam-act">${owned ? icon('check') : '+ ADD'}</span>
    </button>`;
  }).join('');

  const box = document.createElement('div');
  box.className = 'fam-pop';
  box.innerHTML = `
    <div class="fam-head">
      <b>In this franchise</b><span class="fam-n">${shows.length} SHOWS</span>
      <button class="fam-x" data-action="family-close" aria-label="Close">${icon('x')}</button>
    </div>
    <div class="fam-list">${rows}</div>`;
  document.body.appendChild(box);
  familyEl = box;

  /* anchor to the card, then nudge back inside the window */
  const r = cardEl.getBoundingClientRect();
  const w = 320;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
  box.style.left = `${left}px`;
  box.style.width = `${w}px`;
  /* Place it wherever there is more room, and size the list to the room that
     actually exists rather than a fixed max — otherwise it hangs off the
     bottom of a short window. */
  const below = window.innerHeight - r.bottom - 16;
  const above = r.top - 16;
  const room = Math.max(below, above);
  const list = box.querySelector('.fam-list');
  if (list) list.style.maxHeight = `${Math.max(140, Math.min(340, room - 58))}px`;
  if (below >= above) box.style.top = `${r.bottom + 8}px`;
  else box.style.bottom = `${window.innerHeight - r.top + 8}px`;

  /* Belt and braces: whatever the anchor said, the panel ends up on screen.
     A card mid-scroll (or one the compositor hasn't laid out yet) can report a
     rect thousands of pixels away, and a panel nobody can see is worse than a
     slightly misplaced one. */
  requestAnimationFrame(() => {
    const bb = box.getBoundingClientRect();
    if (bb.bottom > window.innerHeight - 8) {
      box.style.bottom = '';
      box.style.top = `${Math.max(8, window.innerHeight - bb.height - 8)}px`;
    } else if (bb.top < 8) {
      box.style.bottom = '';
      box.style.top = '8px';
    }
    box.classList.add('on');
  });
}
document.addEventListener('click', (e) => {
  if (familyEl && !e.target.closest('.fam-pop') && !e.target.closest('[data-action="open-family"]')) closeFamily();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFamily(); });

function openCardMenu(btn) {
  const existing = $('.cmenu');
  const wasMine = existing && btn.closest('.anime-card')?.contains(existing);
  closeCardMenu();
  if (wasMine) return; // second click toggles shut
  const card = btn.closest('.anime-card');
  const rootId = +card.dataset.id;
  const root = library.find((x) => x.id === rootId);
  if (!root) return;
  const p = showProgress(root);
  const complete = p.total > 0 && p.done >= p.total;
  const ids = (btn.dataset.group || '').split(',').map(Number).filter(Boolean);
  const menu = document.createElement('div');
  menu.className = 'cmenu';
  menu.dataset.action = 'menu-noop';
  menu.innerHTML = `
    <button data-action="menu-fav" data-id="${rootId}">${root.favourite ? 'Remove favourite' : 'Add to favourites'}</button>
    <button data-action="menu-watch-all" data-id="${rootId}" data-watch="${complete ? '0' : '1'}">
      ${complete ? 'Mark all unwatched' : 'Mark all seasons watched'}
    </button>
    <button data-action="menu-art" data-id="${rootId}">Change artwork…</button>
    <button class="danger" data-action="menu-remove" data-group="${ids.join(',')}">Remove from shelf</button>`;
  card.appendChild(menu);
  requestAnimationFrame(() => menu.classList.add('on'));
}

/* ——— detail hero ⋯ menu ——— */
function openHeroMenu(btn) {
  const existing = $('.cmenu');
  const wasMine = existing && btn.parentElement.contains(existing);
  closeCardMenu();
  if (wasMine) return; // second click toggles shut
  const s = getViewRecord();
  if (!s) return;
  const menu = document.createElement('div');
  menu.className = 'cmenu';
  menu.dataset.action = 'menu-noop';
  menu.innerHTML = `
    ${s.siteUrl ? `<button data-action="open-url" data-url="${esc(s.siteUrl)}">Open on AniList ↗</button>` : ''}
    <button data-action="link-local" data-id="${detailId}">Link local folder…</button>
    ${library.find((x) => x.id === detailId)?.local?.map ? `<button data-action="organize-local" data-id="${detailId}">Organize local files…</button>
    <button data-action="preconvert-show">Pre-convert for instant play</button>` : ''}
    <button data-action="open-art-modal">Change artwork…</button>
    <button data-action="refresh-show">Refresh data</button>
    <button class="danger" data-action="delete-show">Remove from shelf</button>`;
  btn.parentElement.appendChild(menu);
  requestAnimationFrame(() => menu.classList.add('on'));
}

/* every library id in the same franchise group as `show` */
function groupMemberIds(show) {
  const key = franchiseIds(show);
  return library.filter((x) => setsIntersect(franchiseIds(x), key)).map((x) => x.id);
}

function slimRecord(r) {
  const { franchise, seasons, peek, watched, ...rest } = r;
  return rest;
}

/* user/app fields that live on PEEK records and must survive a re-fetch */
function mergePeekUserData(oldP, slim) {
  if (!oldP) return slim;
  if (oldP.dubSched !== undefined) slim.dubSched = oldP.dubSched;
  if (oldP.dubOverride !== undefined) slim.dubOverride = oldP.dubOverride;
  return slim;
}

/* ——— watched tracking (lives on the franchise ROOT record) ——— */
function watchedMap(root) { return root.watched || (root.watched = {}); }
function watchedList(root, mediaId) { return watchedMap(root)[mediaId] || []; }
function epWatched(root, mediaId, n) { return watchedList(root, mediaId).includes(n); }
function setEpWatched(root, mediaId, n, val) {
  const m = watchedMap(root);
  const set = new Set(m[mediaId] || []);
  val ? set.add(n) : set.delete(n);
  m[mediaId] = [...set].sort((a, b) => a - b);
  root.lastWatchedAt = Date.now();
  persist();
}
function seasonDone(root, mediaId, total) {
  const list = watchedList(root, mediaId);
  const inRange = total ? list.filter((n) => n >= 1 && n <= total) : list;
  return total ? Math.min(inRange.length, total) : inRange.length;
}
/* aggregate progress across the show's TV seasons (fallback: the root itself) */
/* A stored episodesList can be LONGER than the season really is: Kitsu and
   TVDB index some multi-season shows as one continuous run, so records merged
   before that was fixed carry the whole franchise's episodes on a single
   season (The Asterisk War: 24 rows on a 12-episode season 1). AniList's
   per-season `episodes` is authoritative whenever it exists — trust it and
   clip the surplus, so existing records read correctly without re-enriching.
   Mirrors episodesOf/epCount in mobile/src/fold.js — keep in lock-step. */
function episodesOf(rec) {
  const list = rec?.episodesList || [];
  const declared = Number(rec?.episodes) || 0;
  return declared && list.length > declared ? list.slice(0, declared) : list;
}
function epCount(rec) {
  return episodesOf(rec).length || Number(rec?.episodes) || 0;
}

function showProgress(root) {
  const seasons = (root.franchise || []).filter(isSeasonEntry);
  const items = seasons.length ? seasons : [{ id: root.id, episodes: root.episodes || root.episodesList?.length || 0 }];
  let done = 0, total = 0;
  for (const it of items) {
    const t = it.episodes || 0;
    const d = seasonDone(root, it.id, t);
    total += t;
    done += t ? d : watchedList(root, it.id).length;
  }
  return { done, total };
}

/* One record per show: merge accidental duplicate seasons into the group
   root — sources combine, the duplicate's data survives as a season peek. */
function consolidateLibrary() {
  const groups = groupEntries(library);
  let changed = false;
  for (const g of groups) {
    if (g.members.length < 2) continue;
    const root = g.rep;
    for (const m of g.members) {
      if (m === root) continue;
      root.sources = root.sources || [];
      for (const src of m.sources || []) {
        if (!root.sources.some((x) => x.url === src.url)) root.sources.push(src);
      }
      for (const [id, list] of Object.entries(m.watched || {})) {
        const merged = new Set([...(watchedMap(root)[id] || []), ...list]);
        watchedMap(root)[id] = [...merged].sort((a, b) => a - b);
      }
      root.addedAt = Math.min(root.addedAt || Date.now(), m.addedAt || Date.now());
      root.peek = root.peek || {};
      root.peek[m.id] = slimRecord(m);
      peekCache.set(m.id, root.peek[m.id]);
      /* NOT a deletion: the member still exists, inside root.peek. Tombstoning
         it here broadcast "gone forever" to every device, so any show the
         desktop had ever folded became impossible to add again anywhere. */
      library.splice(library.indexOf(m), 1);
      changed = true;
    }
  }
  if (changed) persist();
  return changed;
}

/* ——— banner quality ———
   AniList banners are ~1900px heavily-compressed JPEGs; TMDB/fanart art in the
   pool is original-resolution. Old pools stored w1280 URLs — rewrite on read. */
function hiRes(url) {
  return String(url || '').replace('image.tmdb.org/t/p/w1280', 'image.tmdb.org/t/p/original');
}
/* Which artwork heads the page.

   The order used to be root-first: an image from the ROOT's pool outranked the
   banner belonging to the season you were actually looking at. The pool is
   built from the whole franchise (`[root.id, ...root.franchise]`), so opening
   a spin-off like Toaru Anbu no ITEM under A Certain Magical Index could head
   it with a sibling's art — and when it looked right, that was luck.

   So: an explicit choice always wins, then the artwork of the thing on screen,
   and only then the franchise pool as a fallback for entries that have none of
   their own (common for unaired shows). */
function bestBanner(root, s) {
  const viewing = s && s !== root ? s : null;
  return hiRes(
    (viewing && (viewing.artBanner || viewing.banner))
    || root.artBanner
    || root.banner
    || root.artPool?.banners?.[0]
    || (s && s.banner)
    || ''
  );
}
function artStamp() {
  const t = appSettings.tmdbKey ? 't' : '', f = appSettings.fanartKey ? 'f' : '';
  return `v3:${t}${f}`;
}
/* build the pool in the background so heroes upgrade without opening the picker */
async function fetchPoolInto(root) {
  if (!appSettings.tmdbKey && !appSettings.fanartKey) return false;
  if (root.artPool?.stamp === artStamp()) return false;
  const ids = [root.id, ...(root.franchise || []).map((f) => f.id)];
  const pool = await fetchArtPool(ids, root.idMal, { tmdb: appSettings.tmdbKey || '', fanart: appSettings.fanartKey || '' });
  pool.stamp = artStamp();
  root.artPool = pool;
  return true;
}
/* The `poolAttempted` Set this used to keep meant one failure was permanent
   until restart — a flaky minute cost a show its artwork for the session.
   The queue dedupes by key and retries with backoff, so that guard is gone. */
function prefetchArtPool(root, onDone) {
  if (!appSettings.tmdbKey && !appSettings.fanartKey) return;
  if (root.artPool?.stamp === artStamp()) return;
  window.hikariJobs.add('art', { id: root.id }, {
    key: `art:${root.id}`,
    priority: 'visible',                    // on screen, but nothing is blocked on it
    label: `Artwork · ${root.title}`
  });
  if (onDone) artDone.set(root.id, onDone);
}
/* one-shot callbacks for callers that want to repaint when their art lands */
const artDone = new Map();

/* the record backing the currently viewed franchise member */
/* ——— preview: the detail screen for a show you do not own ———
   Search and Discover used to be add-or-nothing: the only way to see a
   synopsis, the season list or whether there is an English dub was to put
   the show on your shelf and take it off again. A preview record stands in
   for the library record so the same screen can render it, with everything
   that mutates a record hidden behind `owned`. It is never persisted and
   never pushed — it exists for as long as you are looking at it. */
let previewRec = null;
/* Open the detail screen for something not on the shelf. One detail request
   gets the page up; the franchise graph follows in the background exactly as
   it does for a real add, so the watch order fills in behind its skeleton. */
async function goPreview(mediaId) {
  const owned = library.find((x) => x.id === mediaId)
    || library.find((x) => franchiseIds(x).has(mediaId));
  if (owned) { goDetail(owned.id); return; }          // already yours — show the real thing

  if (previewRec?.id !== mediaId) {
    previewRec = { ...(await enrichShowBase(mediaId)), enriching: 1 };
  }
  detailId = mediaId;
  viewId = mediaId;
  morphId = mediaId;
  withTransition(() => { renderDetail(); showScreen('detail'); tagMorph(); });

  /* fill the seasons in behind the loader — but only into the preview, never
     into the library, and only if they are still looking at it */
  const id = mediaId;
  fetchFranchise(id).then((fr) => {
    if (previewRec?.id !== id) return;
    if (fr.length) { previewRec.franchise = fr; previewRec.frv = FRV_RELATIONS; }
    delete previewRec.enriching;
    if (detailId === id && detailScreen.classList.contains('active')) {
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
    }
  }).catch(() => {
    if (previewRec?.id === id) delete previewRec.enriching;
  });
}

const detailRoot = () => library.find((x) => x.id === detailId)
  || (previewRec && previewRec.id === detailId ? previewRec : null);
const detailOwned = () => library.some((x) => x.id === detailId);

function getViewRecord() {
  const root = detailRoot();
  if (!root) return null;
  if (viewId === detailId) return root;
  return peekCache.get(viewId) || root;
}

const peekInflight = new Map(); // id -> promise (hover-prefetch + click share one fetch)
async function fetchPeek(id) {
  if (peekCache.has(id)) return peekCache.get(id);
  if (peekInflight.has(id)) return peekInflight.get(id);
  const p = (async () => {
    const rec = slimRecord(await enrichShow(id, { franchise: false }));
    peekCache.set(id, rec);
    const root = library.find((x) => x.id === detailId);
    if (root) {
      root.peek = root.peek || {};
      root.peek[id] = rec;
      persist();
    }
    return rec;
  })().finally(() => peekInflight.delete(id));
  peekInflight.set(id, p);
  return p;
}

async function switchView(id) {
  await fetchPeek(id);
  if (detailId == null) return;
  viewId = id;
  renderDetail();

  /* airing seasons: quietly refetch stale peeks so new episodes appear */
  const p = peekCache.get(id);
  if (p && p.status === 'RELEASING' && isStale(p)) {
    enrichShow(id, { franchise: false }).then((rec) => {
      const slim = mergePeekUserData(peekCache.get(id), slimRecord(rec));
      peekCache.set(id, slim);
      const root = library.find((x) => x.id === detailId);
      if (root?.peek?.[id]) { root.peek[id] = slim; persist(); }
      if (viewId === id && detailScreen.classList.contains('active')) {
        const st = detailScreen.scrollTop;
        renderDetail();
        detailScreen.scrollTop = st;
      }
    }).catch(() => {});
  }
}

/* ——— freshness ——— */
const STALE_AIRING = 12 * 3600e3;   // airing: new episodes weekly, check twice a day
const STALE_SETTLED = 7 * 24 * 3600e3; // finished: only new season announcements matter
function isStale(rec) {
  const age = Date.now() - (rec.fetchedAt || 0);
  return rec.status === 'RELEASING' ? age > STALE_AIRING : age > STALE_SETTLED;
}

/* re-fetch a show while carrying every piece of user data forward.
   ANY new user-owned field added to records MUST be listed here, or the
   next auto-refresh silently deletes it (the triple-notification bug). */
const REFRESH_CARRY = [
  'sources', 'addedAt', 'watched', 'peek', 'artPool', 'favourite',
  'local', 'playPos', 'dubOverride', 'dubSched', 'notified', 'lastWatchedAt'
];
async function refreshRoot(root) {
  const fresh = await enrichShow(root.id);
  for (const k of REFRESH_CARRY) {
    if (root[k] !== undefined) fresh[k] = root[k];
  }
  fresh.sources = fresh.sources || [];
  fresh.watched = fresh.watched || {};
  fresh.peek = fresh.peek || {};
  if (root.artCover) fresh.artCover = root.artCover;
  if (root.artBanner) fresh.artBanner = root.artBanner;
  const i = library.indexOf(root);
  if (i >= 0) library[i] = fresh; else return root;
  peekCacheReindex(fresh);
  persist();
  return fresh;
}
function peekCacheReindex(root) {
  for (const [id, p] of Object.entries(root.peek || {})) peekCache.set(+id, p);
}

/* one-time backfill: fetch tags for records saved before tags existed.
   Batched id_in queries — 50 records a call, one field, cheap. */
async function upgradeTags() {
  const missing = library.filter((r) => !('tags' in r) && Number.isFinite(r.id));
  if (!missing.length) return;
  const Q = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id
        tags { name rank isMediaSpoiler isAdult }
      }
    }
  }`;
  try {
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const data = await gql(Q, { ids: batch.map((r) => r.id) });
      const byId = new Map((data.Page.media || []).map((m) => [m.id, m.tags]));
      for (const r of batch) r.tags = pickTags(byId.get(r.id));
    }
    persist();
    if (genreFilter.size === 0 && shelfScreen.classList.contains('active')) refreshShelfGrid();
  } catch (e) {
    console.warn('tag backfill will retry next launch:', e.message);
  }
}

/* on launch: quietly bring the stalest few up to date */
async function autoRefresh() {
  const stale = library.filter(isStale)
    .sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0))
    .slice(0, 3);
  let changed = false;
  for (const r of stale) {
    try { await refreshRoot(r); changed = true; } catch { /* next launch */ }
  }
  if (changed && shelfScreen.classList.contains('active')) renderShelf();
}

function emptyHTML() {
  if (library.length) {
    return `
    <div class="empty-wrap"><div class="empty-panel">
      <h2>No matches</h2>
      <p>Nothing in “${esc(VIEW_LABEL[currentView])}” matches${filterText ? ` “${esc(filterText)}”` : ''}.</p>
    </div></div>`;
  }
  return `
  <div class="empty-wrap"><div class="empty-panel">
    <div class="empty-ico">${icon('plus')}</div>
    <div class="jp-big">本棚は空です</div>
    <h2>Your shelf is empty</h2>
    <p>Search the AniList database and add the shows you're watching — seasons, episodes, dubs and artwork come along automatically.</p>
    <button class="btn-primary" data-action="open-search">
      ${icon('magnifying-glass')}
      Search anime <kbd style="background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.25);color:#fff">CTRL K</kbd>
    </button>
    <div class="fmt-row">
      <span class="fmt-chip">TV</span><span class="fmt-chip">MOVIE</span><span class="fmt-chip">OVA</span>
      <span class="fmt-chip">ONA</span><span class="fmt-chip">SPECIAL</span>
    </div>
  </div></div>`;
}

const SORTS = [
  ['recent', 'Recently watched'],
  ['airdate', 'Air date'],
  ['added', 'Recently added'],
  ['title', 'A – Z'],
  ['score', 'Top rated']
];

function genreChipsHTML() {
  if (!genreFilter.size) return '';
  return `<div class="gsel-chips">
    ${[...genreFilter].sort().map((g) => `
      <button class="gchip" data-action="genre-opt" data-genre="${esc(g)}" title="Remove">${esc(g)} ×</button>`).join('')}
    <button class="gclear" data-action="genre-clear">Clear</button>
  </div>`;
}
function tagChipsHTML() {
  if (!tagFilter.size) return '';
  return `<div class="gsel-chips">
    ${[...tagFilter].sort().map((t) => `
      <button class="gchip tag" data-action="tag-opt" data-tag="${esc(t)}" title="Remove">${esc(t)} ×</button>`).join('')}
    <button class="gclear" data-action="tag-clear">Clear</button>
  </div>`;
}

/* the ghost topbar: search + sort/source/genre dropdowns in one sticky strip */
function topbarHTML() {
  const genres = genreIndex();
  const shows = groupEntries(viewFiltered()).length;
  const sortLabel = (SORTS.find(([k]) => k === sortMode) || [])[1] || 'Airdate';
  return `
  <div class="shelf-bar">
    <label class="filter-wrap">
      ${icon('magnifying-glass')}
      <input id="filterInput" class="filter-box" type="text" placeholder="Filter shelf…" value="${esc(filterText)}">
    </label>
    <div class="gsel sec-sort">
      <button class="gsel-btn ${openDd === 'sortDd' ? 'open' : ''}" data-action="sort-dd">
        <span>Sort: ${esc(sortLabel)}</span>
        ${icon('caret-right')}
      </button>
      <div class="gsel-dd" id="sortDd" ${openDd === 'sortDd' ? '' : 'hidden'}>
        ${SORTS.map(([k, label]) => `
        <button class="sort-opt ${sortMode === k ? 'on' : ''}" data-action="set-sort" data-sort="${k}">
          <i></i>${label}
        </button>`).join('')}
      </div>
    </div>
    <div class="gsel sec-sources">
      <button class="gsel-btn ${openDd === 'srcDd' ? 'open' : ''}" data-action="src-dd">
        <span>${sourceFilter.size ? `Source: ${sourceFilter.size}` : 'Source'}</span>
        ${icon('caret-right')}
      </button>
      <div class="gsel-dd" id="srcDd" ${openDd === 'srcDd' ? '' : 'hidden'}>
        ${sourceIndex().length ? sourceIndex().map(([s, n]) => `
        <button class="gopt ${sourceFilter.has(s) ? 'on' : ''} ${s === LOCAL_SRC ? 'local' : ''}" data-action="src-opt" data-src="${esc(s)}">
          <i>${icon('check')}</i><span>${esc(s)}</span><small>${n}</small>
        </button>`).join('') : '<p class="no-eps" style="padding:12px">Add sources to shows first.</p>'}
      </div>
    </div>
    <div class="gsel sec-genres">
      <button class="gsel-btn ${openDd === 'genreDd' ? 'open' : ''}" data-action="genre-dd">
        <span>${genreFilter.size ? `Genres: ${genreFilter.size}` : 'Genres'}</span>
        ${icon('caret-right')}
      </button>
      <div class="gsel-dd" id="genreDd" ${openDd === 'genreDd' ? '' : 'hidden'}>
        ${genres.length ? genres.map(([g, n]) => `
        <button class="gopt ${genreFilter.has(g) ? 'on' : ''}" data-action="genre-opt" data-genre="${esc(g)}">
          <i>${icon('check')}</i><span>${esc(g)}</span><small>${n}</small>
        </button>`).join('') : '<p class="no-eps" style="padding:12px">Add shows first.</p>'}
      </div>
    </div>
    <div class="gsel sec-tags">
      <button class="gsel-btn ${openDd === 'tagDd' ? 'open' : ''}" data-action="tag-dd">
        <span>${tagFilter.size ? `Tags: ${tagFilter.size}` : 'Tags'}</span>
        ${icon('caret-right')}
      </button>
      <div class="gsel-dd wide" id="tagDd" ${openDd === 'tagDd' ? '' : 'hidden'}>
        ${tagIndex().length ? tagIndex().map(([t, n]) => `
        <button class="gopt ${tagFilter.has(t) ? 'on' : ''}" data-action="tag-opt" data-tag="${esc(t)}">
          <i>${icon('check')}</i><span>${esc(t)}</span><small>${n}</small>
        </button>`).join('') : '<p class="no-eps" style="padding:12px">Tags arrive as shows refresh.</p>'}
      </div>
    </div>
    <span class="bar-count">${esc(VIEW_LABEL[currentView])} · ${shows} SHOW${shows === 1 ? '' : 'S'}</span>
  </div>`;
}

function chipsRowHTML() {
  return `
  <div class="shelf-chipsrow">
    <span class="sec-sources-chips">${sourceChipsHTML()}</span>
    <span class="sec-genres-chips">${genreChipsHTML()}</span>
    <span class="sec-tags-chips">${tagChipsHTML()}</span>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   ANNOUNCEMENTS
   What's been confirmed for shows you already follow. The signal is already
   in the data: a franchise walk returns future entries too, and AniList marks
   them NOT_YET_RELEASED. What the walk does NOT keep is a usable date — it
   stores year and month only — so anything announced gets its exact start date
   and episode count fetched once and cached.

   Ordering is the point. A dated announcement is worth more than an undated
   one, and a near one more than a distant one, so: confirmed dates soonest
   first, then month-only, then "announced, no date".  */
const annCache = new Map();          // mediaId -> { day, episodes, cover, status, fetchedAt }
let annBusy = false;

/** Everything upcoming across the shelf, one row per announced entry. */
function announcements() {
  const ownedIds = new Set();
  for (const r of library) { ownedIds.add(r.id); Object.keys(r.peek || {}).forEach((k) => ownedIds.add(+k)); }

  const rows = [];
  const seen = new Set();
  for (const root of library) {
    for (const f of root.franchise || []) {
      if (f.status !== 'NOT_YET_RELEASED') continue;
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const extra = annCache.get(f.id) || {};
      rows.push({
        id: f.id,
        title: f.title || '',
        format: f.format || '',
        year: f.year ?? null,
        /* `sort` is year*100+month from the walk — month 0 means "year only" */
        month: (f.sort || 0) % 100 || null,
        cover: extra.cover || f.cover || '',
        episodes: extra.episodes ?? f.episodes ?? null,
        day: extra.day ?? null,
        at: extra.at ?? null,
        forShow: root,
        owned: ownedIds.has(f.id)
      });
    }
  }

  /* dated first, soonest first; then month-known; then undated by title */
  const rank = (r) => (r.at ? 0 : r.month ? 1 : 2);
  return rows.sort((a, b) =>
    rank(a) - rank(b)
    || (a.at && b.at ? a.at - b.at : 0)
    || ((a.year || 9999) - (b.year || 9999))
    || ((a.month || 13) - (b.month || 13))
    || a.title.localeCompare(b.title));
}

/** Fill in exact dates for announced entries — batched, background priority. */
async function hydrateAnnouncements() {
  if (annBusy) return;
  const want = announcements().filter((r) => !annCache.has(r.id)).map((r) => r.id);
  if (!want.length) return;
  annBusy = true;
  try {
    for (let i = 0; i < want.length; i += 50) {
      const data = await fetchUpcoming(want.slice(i, i + 50));
      for (const [id, m] of data) annCache.set(id, m);
      if (currentView === 'announce' && shelfScreen.classList.contains('active')) renderShelf();
    }
  } catch { /* the page still lists them, just without exact dates */ }
  finally { annBusy = false; }
}

const ANN_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function annWhen(r) {
  if (r.at) {
    const d = new Date(r.at);
    const days = Math.ceil((r.at - Date.now()) / 86400e3);
    const when = days <= 0 ? 'ANY DAY NOW' : days === 1 ? 'TOMORROW' : days < 30 ? `IN ${days} DAYS` : `IN ${Math.round(days / 30)} MONTHS`;
    return { big: `${d.getDate()} ${ANN_MONTHS[d.getMonth()]} ${d.getFullYear()}`, small: when, firm: true };
  }
  if (r.month && r.year) return { big: `${ANN_MONTHS[r.month - 1]} ${r.year}`, small: 'MONTH CONFIRMED', firm: true };
  if (r.year) return { big: String(r.year), small: 'YEAR ONLY', firm: false };
  return { big: 'TBA', small: 'NO DATE YET', firm: false };
}

function announcementsHTML() {
  const rows = announcements();
  if (!rows.length) {
    return `<div class="shelf-pad"><div class="ann-empty">
      <span class="ann-empty-i">${icon('sparkle')}</span>
      <h3>Nothing announced</h3>
      <p>When a show on your shelf gets a new season, film or spin-off confirmed,
         it turns up here — with the date as soon as there is one.</p>
    </div></div>`;
  }
  const dated = rows.filter((r) => r.at || r.month).length;
  return `
  <div class="shelf-pad ann-page">
    <div class="ann-head">
      <div>
        <h2>Announcements</h2>
        <p>New seasons, films and spin-offs confirmed for shows you follow.</p>
      </div>
      <span class="ann-count">${rows.length} UPCOMING${dated ? ` · ${dated} DATED` : ''}</span>
    </div>
    <div class="ann-list">
      ${rows.map((r, i) => {
        const w = annWhen(r);
        const meta = [fmtFormat(r.format), r.episodes ? `${r.episodes} EP` : ''].filter(Boolean).join(' · ');
        return `
        <button class="ann-row ${w.firm ? 'firm' : ''}" data-action="open-announce" data-id="${r.id}"
                data-root="${r.forShow.id}" style="animation-delay:${Math.min(i, 14) * 28}ms">
          <span class="ann-when">
            <b>${esc(w.big)}</b>
            <i>${esc(w.small)}</i>
          </span>
          <span class="ann-cover">${r.cover ? `<img src="${esc(r.cover)}" alt="" loading="lazy" decoding="async">` : ''}</span>
          <span class="ann-info">
            <span class="ann-title">${esc(r.title)}</span>
            <span class="ann-meta">${meta ? `${esc(meta)} · ` : ''}FROM <b>${esc(r.forShow.title)}</b></span>
          </span>
          <span class="ann-act${r.owned ? '' : ' go'}">${r.owned ? 'ON SHELF' : '+ ADD'}</span>
        </button>`;
      }).join('')}
    </div>
  </div>`;
}

function renderShelf() {
  closeCardMenu();
  if (currentView === 'discover') { renderDiscover(); return; }
  if (currentView === 'browse') {
    /* the module owns everything inside #browseHost; the shelf screen just
       provides the container so the rail can be sticky against it */
    if (!document.getElementById('browseHost')) {
      shelfScreen.innerHTML = '<div id="browseHost" class="browse-wrap"></div>';
    }
    window.hikariBrowse.open();
    return;
  }
  if (currentView === 'announce') {
    patchHTML(shelfScreen, billboardHTML() + announcementsHTML());
    hydrateAnnouncements();
    const art = $('.billboard .bb-slide.on .bb-art', shelfScreen);
    if (art) setAmbient(art.src);
    bbRestart();
    return;
  }
  patchHTML(shelfScreen, `
    ${library.length ? `
    ${topbarHTML()}
    ${billboardHTML()}
    <div class="shelf-layout">
      <div class="shelf-main">
        ${chipsRowHTML()}
        ${currentView === 'airing' ? calendarHTML() : ''}
        ${continueRailHTML()}
        ${airRailHTML()}
        ${shelfGridHTML()}
      </div>
    </div>` : `<div class="shelf-pad">${shelfGridHTML()}</div>`}
  `);
  const bbArt = $('.billboard .bb-slide.on .bb-art', shelfScreen) || $('.billboard .bb-art', shelfScreen);
  if (bbArt) setAmbient(bbArt.src);
  bbRestart();
  requestAnimationFrame(updateRailNavs);
  if (currentView === 'airing') {
    upgradeAiringPeeks();
    /* dub schedules for whatever's on the calendar */
    let fetched = 0;
    for (const root of library) {
      for (const rec of [root, ...Object.values(root.peek || {})]) {
        if (rec.status !== 'RELEASING' || fetched >= 6) continue;
        fetched++;
        upgradeDubSched(rec, () => {
          if (currentView === 'airing' && shelfScreen.classList.contains('active')) renderShelf();
        });
      }
    }
  }

  updateChrome();
}

/* Delegated, bound once. Binding inside renderShelf was fine while the screen
   was thrown away each time, but the input now SURVIVES a patch — re-binding
   per render would stack a fresh listener on the same node every sync echo. */
let filterDeb = 0;
document.addEventListener('input', (e) => {
  if (e.target?.id !== 'filterInput') return;
  filterText = e.target.value;
  clearTimeout(filterDeb);
  filterDeb = setTimeout(refreshShelfGrid, 110);
});

/* apply `openDd` to the DOM without a full re-render */
function syncDropdowns() {
  for (const id of ['sortDd', 'srcDd', 'genreDd', 'tagDd']) {
    const dd = $(`#${id}`, shelfScreen);
    if (dd) dd.hidden = openDd !== id;
  }
  $$('.gsel-btn', shelfScreen).forEach((b) => {
    const dd = b.parentElement?.querySelector('.gsel-dd');
    b.classList.toggle('open', !!dd && !dd.hidden);
  });
}

/* refresh only the grid + filter UI bits (keeps dropdowns open) */
function refreshShelfGrid() {
  const holder = $('.shelf-main .grid', shelfScreen) || $('.shelf-main .empty-wrap', shelfScreen);
  if (holder) patchOuter(holder, shelfGridHTML());
  const gBtn = $('.sec-genres .gsel-btn span', shelfScreen);
  if (gBtn) gBtn.textContent = genreFilter.size ? `Genres: ${genreFilter.size}` : 'Genres';
  const tBtn = $('.sec-tags .gsel-btn span', shelfScreen);
  if (tBtn) tBtn.textContent = tagFilter.size ? `Tags: ${tagFilter.size}` : 'Tags';
  const sBtn = $('.sec-sources .gsel-btn span', shelfScreen);
  if (sBtn) sBtn.textContent = sourceFilter.size ? `Source: ${sourceFilter.size}` : 'Source';
  const cnt = $('.shelf-bar .bar-count', shelfScreen);
  if (cnt) {
    const shows = groupEntries(viewFiltered()).length;
    cnt.textContent = `${VIEW_LABEL[currentView]} · ${shows} SHOW${shows === 1 ? '' : 'S'}`;
  }
  $('.sec-genres-chips .gsel-chips', shelfScreen)?.remove();
  $('.sec-genres-chips', shelfScreen)?.insertAdjacentHTML('beforeend', genreChipsHTML());
  $('.sec-tags-chips .gsel-chips', shelfScreen)?.remove();
  $('.sec-tags-chips', shelfScreen)?.insertAdjacentHTML('beforeend', tagChipsHTML());
  $('.sec-sources-chips .gsel-chips', shelfScreen)?.remove();
  $('.sec-sources-chips', shelfScreen)?.insertAdjacentHTML('beforeend', sourceChipsHTML());
}

/* ———————————————————— detail ———————————————————— */
/* AniList descriptions carry attribution + broadcast trivia — not synopsis */
function cleanSynopsis(t) {
  return String(t || '')
    .replace(/\(Source:[^)]*\)\.?/gi, '')
    .replace(/(^|\n)\s*Notes?:[\s\S]*$/i, '')
    .replace(/(^|\n)[ \t]*(?:\.{3}|…)[ \t]*(?=\n|$)/g, '$1') // ellipsis-only lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ——— dub progress (AnimeSchedule data + optional user override) ——— */
const dubSchedAttempted = new Set();
function upgradeDubSched(rec, onDone) {
  if (rec.status !== 'RELEASING' || !rec.idMal) return;
  const fresh = rec.dubSched && Date.now() - (rec.dubSched.fetchedAt || 0) < 12 * 3600e3;
  if (fresh || dubSchedAttempted.has(rec.id)) return;
  dubSchedAttempted.add(rec.id);
  fetchDubSchedule(rec.idMal).then((d) => {
    rec.dubSched = { ...(d || {}), fetchedAt: Date.now() };
    persist();
    onDone?.();
  }).catch(() => {});
}

function recHasDub(rec) {
  return (rec.dubLanguages || []).includes('English') || !!rec.dubSched?.dubPremier;
}

/* which dub episodes are out, and when the next one lands */
function dubInfo(rec) {
  if (rec.status !== 'RELEASING' || !recHasDub(rec)) return null;
  const d = rec.dubSched || {};
  const WEEK = 604800e3;
  const now = Date.now();
  const total = rec.episodes || (rec.episodesList || []).length || 0;
  const aired = rec.nextAiring ? Math.max(0, rec.nextAiring.episode - 1) : total;

  let first = null;
  let source = 'schedule';
  if (rec.dubOverride?.at && rec.dubOverride.ep != null) {
    first = rec.dubOverride.at - (rec.dubOverride.ep - 1) * WEEK;
    source = 'manual';
  } else if (d.dubPremier) {
    const prem = new Date(d.dubPremier);
    if (d.dubTime) {
      const t = new Date(d.dubTime);
      prem.setUTCHours(t.getUTCHours(), t.getUTCMinutes(), 0, 0);
    }
    first = prem.getTime();
  } else {
    return null; // dub exists but no schedule data — stay silent rather than guess
  }

  /* a recorded dub delay pushes everything after it back by whole weeks */
  let delayWeeks = 0, delayFrom = Infinity;
  if (d.dubDelayedFrom && d.dubDelayedUntil) {
    const f = Date.parse(d.dubDelayedFrom), u = Date.parse(d.dubDelayedUntil);
    if (u > f) { delayWeeks = Math.ceil((u - f) / WEEK); delayFrom = f; }
  }
  const epAt = (ep) => {
    let t = first + (ep - 1) * WEEK;
    if (t >= delayFrom) t += delayWeeks * WEEK;
    return t;
  };

  let upTo = 0;
  const cap = Math.max(aired, 1);
  while (upTo < cap && epAt(upTo + 1) <= now) upTo++;
  if (aired) upTo = Math.min(upTo, aired);
  const nextEp = total && upTo >= total ? null : upTo + 1;
  return { upTo, nextEp, nextAt: nextEp ? epAt(nextEp) : null, aired, source };
}

/* synopsis block — the left column's opener */
function synopsisHTML(s) {
  const synopsis = cleanSynopsis(s.description);
  return `
  <div class="d-syn">
    <p class="mini-label">Synopsis</p>
    ${synopsis
      ? `<p class="description clamped" id="desc">${esc(synopsis)}</p>
         <button class="more-toggle" data-action="toggle-desc">Read more</button>`
      : '<p class="no-eps">No synopsis available.</p>'}
  </div>`;
}

/* the airing card: one confirmed date, weekly projections after it */
function airingCardHTML(s) {
  const n = s.nextAiring;
  if (!n?.airingAt || s.status !== 'RELEASING') return '';
  const total = s.episodes || (s.episodesList || []).length || 0;
  const next = new Date(n.airingAt * 1000);
  const rows = [];
  for (let k = 1; k < 4; k++) {
    const ep = n.episode + k;
    if (total && ep > total) break;
    const t = new Date((n.airingAt + k * 604800) * 1000);
    rows.push({
      ep,
      day: t.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
      time: t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  }
  const left = total ? total - n.episode + 1 : 0;
  return `
  <div class="rail-card air-card">
    <p class="rail-label">Next episode</p>
    <div class="air-hero">
      <span class="air-ep">EP ${n.episode}</span>
      <span class="air-chip">${esc(fmtAiring(n).replace(`EP ${n.episode} `, ''))}</span>
    </div>
    <p class="air-date">${esc(next.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))}
      · ${esc(next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</p>
    ${rows.length ? `
    <div class="air-rows">
      ${rows.map((r) => `
      <div class="air-row">
        <span class="ar-ep">EP ${r.ep}</span>
        <span class="ar-day">${esc(r.day)}</span>
        <span class="ar-time">${esc(r.time)} <i>EST.</i></span>
      </div>`).join('')}
    </div>` : ''}
    ${left ? `<p class="air-note">${left} EPISODE${left === 1 ? '' : 'S'} LEFT THIS SEASON</p>` : ''}
  </div>`;
}

/* NEXT DUB — kurenai's card: big episode + date, schedule note, calibrator */
function dubCardHTML(s) {
  const di = dubInfo(s);
  if (!di) return '';
  const when = di.nextAt ? new Date(di.nextAt) : null;
  const lagW = s.nextAiring && di.nextAt
    ? Math.round((di.aired - di.upTo)) : null;
  return `
  <div class="rail-card dub-card">
    <p class="rail-label">Next dub episode</p>
    <div class="dc-big">${di.nextEp && when
      ? `<b>EP ${di.nextEp}</b><small>${esc(when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase())} · ${esc(when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</small>`
      : `<b>DONE</b><small>ALL EPISODES DUBBED</small>`}</div>
    <p class="dc-sub">Weekly cadence${lagW && lagW > 0 ? ` · dub trails sub by <b>${lagW} EP${lagW === 1 ? '' : 'S'}</b>` : ''} · ${di.source === 'manual' ? 'calibrated by you' : 'AnimeSchedule'}</p>
    <div class="air-dub">
      <span class="ad-tag">DUB</span>
      <span class="ad-main">OUT UP TO EP ${di.upTo}</span>
      <span class="ad-cal" title="Correct the dub progress if it's off">
        AT EP <b>${di.upTo}</b>
        <button class="ad-btn" data-action="dub-adj" data-d="-1">−</button>
        <button class="ad-btn" data-action="dub-adj" data-d="1">+</button>
      </span>
    </div>
  </div>`;
}

/* LOCAL FILES — what's on disk for the viewed season */
function localCardHTML(root, s) {
  const eps = root.local?.map?.[s.id];
  const n = eps ? Object.keys(eps).length : 0;
  if (!n) return '';
  const dir = (root.local?.dirs || [])[0] || '';
  return `
  <div class="rail-card local-card">
    <p class="rail-label">Local files</p>
    <div class="lc-big">${n}<small>EPISODE${n === 1 ? '' : 'S'} ON DISK</small></div>
    ${dir ? `<p class="lc-path" title="${esc(dir)}">${esc(dir)}</p>` : ''}
    <button class="btn-ghost mini lc-conv" data-action="preconvert-show">Pre-convert for instant play</button>
  </div>`;
}

/* the sticky right rail: airing schedule, facts, audio */
function sideRailHTML(s) {
  const langs = s.dubLanguages || [];
  const hasEn = langs.includes('English');
  const kv = [
    ['Premiered', [s.season, s.year].filter(Boolean).join(' ') || '—'],
    ['Status', fmtStatus(s.status) || '—'],
    ...(s.studios?.length ? [['Studio', s.studios.join(', ')]] : []),
    ...(s.duration ? [['Episode length', `${s.duration} min`]] : [])
  ];
  const root = detailRoot() || s;
  return `
  ${airingCardHTML(s)}
  ${dubCardHTML(s)}
  <div class="rail-card">
    <p class="rail-label">Details</p>
    <div class="kv-rows">
      ${kv.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
    </div>
    ${langs.length ? `
    <p class="rail-label" style="margin-top:20px">Audio</p>
    <div class="langs">
      ${langs.map((l) => `<span class="lang ${l === 'Japanese' ? 'orig' : ''} ${l === 'English' ? 'en' : ''}">${esc(l)}</span>`).join('')}
    </div>
    ${hasEn ? '' : '<p class="dub-note">Subtitles only — no English dub found</p>'}` : ''}
  </div>
  ${localCardHTML(root, s)}`;
}

const CHEV_L = icon('caret-left');
const CHEV_R = icon('caret-right');

function railHTML(inner) {
  return `<div class="rail-wrap">
    <button class="rail-nav prev" data-action="rail" data-dir="prev" aria-label="Scroll left">${CHEV_L}</button>
    <div class="rail-scroll">${inner}</div>
    <button class="rail-nav next" data-action="rail" data-dir="next" aria-label="Scroll right">${CHEV_R}</button>
  </div>`;
}

/* franchise rail card — a tab that switches the page's viewed season */
function relCardHTML(r, currentId, tag) {
  const isCurrent = r.id === currentId;
  return `
  <div class="rel-card ${isCurrent ? 'now' : ''}" ${isCurrent ? '' : `data-action="view-related" data-id="${r.id}"`}>
    <div class="rel-cover">
      ${r.cover ? `<img src="${esc(r.cover)}" alt="" loading="lazy" decoding="async">` : ''}
      <span class="rel-tag">${esc(tag)}</span>
      ${isCurrent ? `<span class="rel-cta showing">VIEWING</span>` : `<span class="rel-cta">VIEW</span>`}
    </div>
    <p>${esc(r.title)}</p>
    <span class="rel-year">${r.year || ''}${r.episodes ? ` · ${r.episodes} EP` : ''}</span>
  </div>`;
}

/* a rail section (Movies / OVAs / legacy Related) — cards switch the view */
function relRailHTML(title, items, currentId, tagFn) {
  if (!items.length) return '';
  return `
  <div class="dsec">
    <h3 class="sh">${title} <span class="cnt">${items.length} TITLE${items.length === 1 ? '' : 'S'}</span></h3>
    ${railHTML(items.map((r, i) => relCardHTML(r, currentId, tagFn(r, i))).join(''))}
  </div>`;
}

/* the whole franchise as one numbered, chronological watch order —
   fetchFranchise already sorts by air date, so index order IS the order */
function watchOrderHTML(fr, root, s) {
  /* The franchise graph now lands after the page opens, so say the section
     is coming rather than letting it pop in unannounced — an add that shows
     no seasons reads as an add that failed. */
  if (root.enriching) {
    return `
  <div class="dsec">
    <h3 class="sh">Watch order <span class="cnt">LOADING SEASONS…</span></h3>
    <div class="wo-skel">${Array.from({ length: 5 }, () => `
      <div class="skel-card"><div class="skel-cover"></div><div class="skel-line"></div><div class="skel-line short"></div></div>`).join('')}</div>
  </div>`;
  }
  if (!fr || fr.length < 2) return '';
  return `
  <div class="dsec">
    <h3 class="sh">Watch order <span class="cnt">${fr.length} TITLES · CHRONOLOGICAL</span></h3>
    ${railHTML(fr.map((r, i) => {
      const isCurrent = r.id === s.id;
      const t = r.episodes || 0;
      const d = seasonDone(root, r.id, t);
      const done = t > 0 && d >= t;
      const dub = r.dub || (peekCache.get(r.id)?.dubLanguages || []).includes('English')
        || (r.id === root.id && (root.dubLanguages || []).includes('English'));
      return `
      <div class="rel-card wo ${isCurrent ? 'now' : ''}" ${isCurrent ? '' : `data-action="view-related" data-id="${r.id}"`}>
        <div class="rel-cover">
          ${r.cover ? `<img src="${esc(r.cover)}" alt="" loading="lazy" decoding="async">` : ''}
          <span class="wo-num">${i + 1} · ${esc(fmtFormat(r.format) || 'TBA')}</span>
          ${done ? '<span class="wo-done" title="Watched">✓</span>' : ''}
          ${dub ? '<span class="wo-dub">EN DUB</span>' : ''}
          ${isCurrent ? `<span class="rel-cta showing">VIEWING</span>` : `<span class="rel-cta">VIEW</span>`}
        </div>
        <p>${esc(r.title)}</p>
        <span class="rel-year">${r.year || 'TBA'}${r.episodes ? ` · ${r.episodes} EP` : ''}${dub ? ' · <b class="ry-dub">DUB</b>' : ''}</span>
      </div>`;
    }).join(''))}
  </div>`;
}

/* ——— per-episode menu + details panel ——— */
function epRecFor(mediaId) {
  const v = getViewRecord();
  if (v?.id === mediaId) return v;
  const root = detailRoot();
  if (root?.id === mediaId) return root;
  return peekCache.get(mediaId) || root;
}

function openEpMenu(btn) {
  const existing = $('.cmenu');
  const wasMine = existing && btn.closest('.ep-card, .ep-row')?.contains(existing);
  closeCardMenu();
  if (wasMine) return; // second click toggles shut
  const root = library.find((x) => x.id === detailId);
  if (!root) return;
  const mediaId = +btn.dataset.media, n = +btn.dataset.n;
  const rec = epRecFor(mediaId);
  const e = (rec?.episodesList || []).find((x) => x.number === n) || { number: n, title: `Episode ${n}` };
  const dest = epDestFor(root, rec || root, e);
  const lf = localFileFor(root, mediaId, n);
  const seen = epWatched(root, mediaId, n);
  const menu = document.createElement('div');
  menu.className = 'cmenu ep-cmenu';
  menu.dataset.action = 'menu-noop';
  menu.innerHTML = `
    ${dest.play ? `<button ${dest.act}>${dest.local ? '▶ Play' : `Open on ${esc(dest.site || 'stream')} ↗`}</button>` : ''}
    <button data-action="ep-info" data-media="${mediaId}" data-n="${n}">Episode details…</button>
    <button data-action="toggle-ep" data-media="${mediaId}" data-n="${n}">${seen ? 'Unmark watched' : '✓ Mark watched'}</button>
    <button data-action="ep-upto" data-media="${mediaId}" data-n="${n}">Mark watched up to here</button>
    ${lf ? `<button data-action="ep-reveal" data-path="${esc(lf)}">Show file in folder</button>` : ''}`;
  btn.closest('.ep-card, .ep-row')?.appendChild(menu);
  requestAnimationFrame(() => menu.classList.add('on'));
}

function openEpInfo(mediaId, n) {
  const root = detailRoot();
  const rec = epRecFor(mediaId);
  const e = (rec?.episodesList || []).find((x) => x.number === n);
  if (!root || !e) { toast('No details for this episode yet'); return; }
  const dest = epDestFor(root, rec, e);
  const seen = epWatched(root, mediaId, n);
  const lf = localFileFor(root, mediaId, n);
  const di = dubInfo(rec);
  const dubState = !di || e.number > di.aired ? ''
    : (e.number <= di.upTo ? '<span class="dp-chip dub">DUB OUT</span>' : '<span class="dp-chip">SUB ONLY</span>');
  $('#epBody').innerHTML = `
    <div class="dp-hero ep">
      ${e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="">` : `<span class="ep-blank big">${String(n).padStart(2, '0')}</span>`}
      <div class="dp-shade"></div>
    </div>
    <div class="dp-body">
      <p class="dp-kick">EPISODE ${n}${e.absolute ? ` · ABS ${e.absolute}` : ''} — ${esc(rec.title)}</p>
      <h2>${esc(e.title)}</h2>
      <div class="dp-meta">
        ${e.aired ? `<span class="dp-chip">${esc(e.aired)}</span>` : ''}
        ${e.runtime ? `<span class="dp-chip">${e.runtime} MIN</span>` : ''}
        ${e.score ? `<span class="dp-chip star">★ ${Number(e.score).toFixed(1)}</span>` : ''}
        ${e.filler ? '<span class="dp-chip">FILLER</span>' : ''}
        ${e.recap ? '<span class="dp-chip">RECAP</span>' : ''}
        ${dubState}
        ${lf ? '<span class="dp-chip local">ON DISK</span>' : ''}
        ${seen ? '<span class="dp-chip">✓ WATCHED</span>' : ''}
      </div>
      ${e.overview
        ? `<p class="dp-syn">${esc(e.overview)}</p>`
        : `<p class="dp-syn none">No episode synopsis available${(rec.epv || 0) < EP_VERSION ? ' yet — refreshing episode data…' : ''}.</p>`}
      <div class="dp-actions">
        ${dest.play ? `<button class="btn-primary" ${dest.act}>${dest.local ? '▶ Play' : 'Open ↗'}</button>` : ''}
        <button class="btn-ghost" data-action="toggle-ep" data-media="${mediaId}" data-n="${n}">${seen ? 'Unmark watched' : '✓ Mark watched'}</button>
        <button class="btn-ghost" data-action="ep-close">Close</button>
      </div>
    </div>`;
  const modal = $('#epModal');
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('on'));
}
function closeEpInfo() {
  const modal = $('#epModal');
  modal.classList.remove('on');
  setTimeout(() => { modal.hidden = true; }, 200);
}

/* ——— trailer ——— */
const trailerAttempted = new Set();
function upgradeTrailer(s) {
  if (trailerAttempted.has(s.id)) return;
  trailerAttempted.add(s.id);
  fetchTrailerId(s.id).then((t) => {
    s.trailer = t;
    persist();
    if (t && viewId === s.id && detailScreen.classList.contains('active')) {
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
    }
  }).catch(() => {});
}
function openTrailer(ytId) {
  const modal = $('#trailerModal');
  $('#trailerBody').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(ytId)}?autoplay=1&rel=0"
    title="Trailer" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`;
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('on'));
}
function closeTrailer() {
  const modal = $('#trailerModal');
  modal.classList.remove('on');
  setTimeout(() => { modal.hidden = true; $('#trailerBody').innerHTML = ''; }, 200);
}

/* ——— new-episode notifications ——— */
function checkEpisodeDrops() {
  if (appSettings.notifyEps === false) return;
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const root of [...library]) {
    for (const rec of [root, ...Object.values(root.peek || {})]) {
      if (!rec.nextAiring?.airingAt || rec.nextAiring.airingAt > now) continue;
      const { episode } = rec.nextAiring;
      const seenUpTo = (root.notified || {})[rec.id] || 0;
      if (episode <= seenUpTo) continue;
      (root.notified = root.notified || {})[rec.id] = episode;
      changed = true;
      /* aired ages ago (app was closed / data was stale): mark seen, stay quiet */
      const quiet = now - rec.nextAiring.airingAt > 3 * 86400;
      if (!quiet) {
        try {
          const n = new Notification(rec.title || root.title, {
            body: `Episode ${episode} is out now`,
            icon: rec.cover || root.cover
          });
          n.onclick = () => goDetail(root.id);
        } catch { /* OS notifications unavailable — the toast still lands */ }
        toast(`${rec.title || root.title} — EP ${episode} is out`);
      }
      /* advance the aired record's schedule — the PEEK itself when the drop
         came from a season peek, else the root */
      if (rec.id === root.id) {
        refreshRoot(root).catch(() => {});
      } else {
        enrichShow(rec.id, { franchise: false }).then((freshRec) => {
          const slim = mergePeekUserData(rec, slimRecord(freshRec));
          peekCache.set(rec.id, slim);
          if (root.peek?.[rec.id]) { root.peek[rec.id] = slim; persist(); }
        }).catch(() => {});
      }
    }
  }
  if (changed) persist();
}

/* fetch the full franchise for records saved before this feature existed */
const upgradeAttempted = new Set();
function upgradeFranchise(s) {
  if (upgradeAttempted.has(s.id)) return;
  upgradeAttempted.add(s.id);
  fetchFranchise(s.id).then((fr) => {
    s.franchise = fr;
    s.frv = FRV_RELATIONS;
    persist();
    if (detailId === s.id && detailScreen.classList.contains('active')) renderDetail();
  }).catch(() => {});
}


/* where should clicking an episode take you? local file → in-app player; a
   streaming deep-link only if its site is one of YOUR sources (AniList links
   are usually Crunchyroll — useless when you watch on HIDIVE); otherwise your
   first source's page. */
function epDestFor(root, rec, e) {
  const lf = localFileFor(root, rec.id, e.number);
  if (lf) return { act: `data-action="play-local" data-media="${rec.id}" data-n="${e.number}"`, site: e.site, play: true, local: true };
  const srcBrands = new Set((root.sources || []).map((x) => canonicalSource(x.name)));
  const firstSrc = (root.sources || [])[0] || null;
  if (e.url && (!srcBrands.size || srcBrands.has(canonicalSource(e.site)))) {
    return { act: `data-action="open-url" data-url="${esc(e.url)}"`, site: e.site, play: true, local: false };
  }
  if (firstSrc) {
    return { act: `data-action="open-url" data-url="${esc(firstSrc.url)}"`, site: firstSrc.name, play: true, local: false };
  }
  return e.url
    ? { act: `data-action="open-url" data-url="${esc(e.url)}"`, site: e.site, play: true, local: false }
    : { act: '', site: e.site, play: false, local: false };
}

function episodesHTML(root, s) {
  /* one unified pipeline — older records get adapted rows + a background upgrade */
  let rows = [];
  if ((s.epv || 0) >= EP_VERSION) {
    rows = episodesOf(s);
  } else if (s.episodesList?.length) {
    rows = episodesOf(s).map((e) => ({ aired: '', filler: false, ...e }));
  } else if (s.jikanEpisodes?.length) {
    rows = s.jikanEpisodes.map((e) => ({ ...e, thumbnail: '', url: '', site: '' }));
  }
  if ((s.epv || 0) < EP_VERSION) upgradeEpisodes(s);

  if (!rows.length) {
    return {
      badge: '',
      body: `<p class="no-eps">No per-episode data available${s.episodes ? ` — ${s.episodes} episodes total` : ''}.</p>`
    };
  }

  const syncing = (s.epv || 0) < EP_VERSION;
  const syncNote = syncing
    ? `<p class="sync-note"><span class="spinner"></span> MERGING EPISODE DATA — TVDB · MAL · KITSU…</p>`
    : '';
  if (!rows.length && syncing) {
    return {
      badge: 'FETCHING…',
      body: `${syncNote}<div class="ep-list">${Array.from({ length: 6 }, () =>
        `<div class="ep-row"><span class="ep-mini skel"></span><span class="skel skel-line" style="flex:1;margin-top:0"></span></div>`).join('')}</div>`
    };
  }

  const badge = `${rows.length} EPISODES${s.epSources ? ` · ${esc(s.epSources)}` : ''}${syncing ? ' · SYNCING' : ''}`;
  const thumbs = rows.filter((r) => r.thumbnail).length;
  const CHECK = icon('check');
  const checkBtn = (e) => `
    <button class="ep-check ${epWatched(root, s.id, e.number) ? 'on' : ''}"
      data-action="toggle-ep" data-media="${s.id}" data-n="${e.number}"
      title="Mark watched">${CHECK}</button>`;

  const epDest = (e) => epDestFor(root, s, e);

  /* per-episode dub state for airing dubbed shows (real schedule data) */
  const di = dubInfo(s);
  const dubPill = (e) => {
    if (!di || e.number > di.aired) return '';
    return e.number <= di.upTo
      ? '<i class="ep-dub">DUB</i>'
      : `<i class="ep-dub none" title="Dub ${di.nextEp === e.number && di.nextAt ? new Date(di.nextAt).toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'later'}">SUB ONLY</i>`;
  };

  /* thumbnail GRID when stills coverage is high enough to look intentional —
     rows remain the fallback for shows without episode art */
  if (thumbs >= Math.max(4, rows.length * 0.5)) {
    const shown = rows; // all episodes, always — offscreen cards render for free
    const cards = shown.map((e, i) => {
      const dest = epDest(e);
      return `
      <figure class="ep-card ${epWatched(root, s.id, e.number) ? 'seen' : ''}" data-key="ep-${s.id}-${e.number}" ${dest.act} style="animation-delay:${Math.min(i, 18) * 22}ms">
        <div class="ep-thumb">
          ${e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="" loading="lazy" decoding="async">` : `<span class="ep-blank">${String(e.number).padStart(2, '0')}</span>`}
          ${localFileFor(root, s.id, e.number) ? '<span class="ep-local">LOCAL</span>' : ''}
          ${e.filler ? `<span class="ep-site">FILLER</span>` : ''}
          ${dest.play ? `<span class="ep-play"><span>${icon('play')}</span></span>` : ''}
          ${checkBtn(e)}
          <button class="ep-menu" data-action="ep-menu" data-media="${s.id}" data-n="${e.number}" title="Options">${icon('dots-three')}</button>
        </div>
        <div class="ep-cap">
          <span class="en">E${e.number}${e.aired ? ` · ${esc(e.aired)}` : ''}${dubPill(e)}</span>
          <figcaption>${esc(e.title)}</figcaption>
        </div>
      </figure>`;
    }).join('');
    return { badge, body: `${syncNote}<div class="ep-grid">${cards}</div>` };
  }

  /* ghost episode rows — thumb, play ring, tags right; the fallback layout */
  const shown = rows;
  return {
    badge,
    body: `${syncNote}
    <div class="ep-list">
      ${shown.map((e) => {
        const dest = epDest(e);
        return `
      <div class="ep-row ${dest.play ? 'link' : ''} ${epWatched(root, s.id, e.number) ? 'seen' : ''}" data-key="ep-${s.id}-${e.number}" ${dest.act}>
        <span class="n">${String(e.number).padStart(2, '0')}</span>
        <span class="ep-go">${dest.play ? icon('play') : ''}</span>
        ${e.thumbnail
          ? `<span class="ep-mini"><img src="${esc(e.thumbnail)}" alt="" loading="lazy" decoding="async"></span>`
          : `<span class="ep-mini blank">${String(e.number).padStart(2, '0')}</span>`}
        <span class="t">${esc(e.title)}</span>
        ${localFileFor(root, s.id, e.number) ? '<span class="ep-local inline">LOCAL</span>' : ''}
        ${dubPill(e)}
        ${e.filler ? `<span class="filler-chip">FILLER</span>` : ''}
        <span class="d">${esc(e.aired)}</span>
        <button class="ep-menu" data-action="ep-menu" data-media="${s.id}" data-n="${e.number}" title="Options">${icon('dots-three')}</button>
        ${checkBtn(e)}
      </div>`;
      }).join('')}
    </div>`
  };
}

/* re-fetch + merge episodes for records saved before the TVDB-era pipeline */
async function mergeEpisodesInto(s) {
  const anilistEps = (s.episodesList || []).filter((e) => e.number != null);
  const jikanRows = await fetchJikanEpisodes(s.idMal);
  /* The air date is what aligns a split cour: TVDB numbers Slime S2 as one
     24-episode season while AniList splits it into two 12s, so without a
     date to anchor on, Part 2 silently gets Part 1's stills. enrichShowBase
     passed this from the start; THIS path — the one that re-enriches records
     you already have — did not, which is why the fix never reached them.
     Falls back to the record's own start date when Jikan has no rows. */
  const firstAired = jikanRows.find((r) => r.number === 1)?.aired || s.startDate || null;
  const tvdb = await fetchTvdbEpisodes(s.idMal, firstAired);
  const kitsu = tvdb.size >= (s.episodes || 1) ? { count: 0, map: new Map() } : await fetchKitsuEpisodes(s.idMal);
  s.episodesList = mergeEpisodes(s.episodes, anilistEps, jikanRows, kitsu, tvdb);
  s.epSources = [
    tvdb.size ? 'TVDB' : null,
    jikanRows.length ? 'MAL' : null,
    kitsu.map.size ? 'KITSU' : null,
    anilistEps.length ? 'ANILIST' : null
  ].filter(Boolean).join(' + ') || 'NONE';
  s.epv = EP_VERSION;
}
const epUpgradeAttempted = new Set();
function upgradeEpisodes(s) {
  if ((s.epv || 0) >= EP_VERSION || epUpgradeAttempted.has(s.id)) return;
  epUpgradeAttempted.add(s.id);
  (async () => {
    try {
      await mergeEpisodesInto(s);
      persist();
      if (viewId === s.id && detailScreen.classList.contains('active')) renderDetail();
    } catch { /* keep existing rows */ }
  })();
}

function renderDetail() {
  const root = detailRoot();
  if (!root) { goShelf(); return; }
  const owned = detailOwned();
  detailScreen.classList.toggle('preview', !owned);
  if (viewId !== detailId && !peekCache.has(viewId)) viewId = detailId;
  const s = getViewRecord(); // the season being viewed drives everything visual

  const airing = fmtAiring(s.nextAiring);
  const dubbed = (s.dubLanguages || []).includes('English');
  const banner = bestBanner(root, s);
  const heroImg = banner || s.cover;
  const hasBanner = !!banner;
  const showColor = s.coverColor || root.coverColor || '#E4A15D';

  /* watch CTA: first user source wins, else first official stream */
  const firstSrc = (root.sources || [])[0] || null;
  const firstOfficial = (s.streamingLinks || [])[0] || null;
  const ctaName = firstSrc ? firstSrc.name : firstOfficial ? firstOfficial.site : null;
  const ctaBrand = ctaName ? brandColor(ctaName) : null;
  const cta = firstSrc
    ? { label: `Watch on ${firstSrc.name}`, url: firstSrc.url }
    : firstOfficial ? { label: `Watch on ${firstOfficial.site}`, url: firstOfficial.url } : null;

  const srcChips = (root.sources || []).map((src, i) => `
    <span class="src-chip" style="--brand:${esc(brandColor(src.name))}">
      <button class="src-open" data-action="open-url" data-url="${esc(src.url)}" title="${esc(src.url)}"><i></i>${esc(src.name)}</button>
      <button class="src-x" data-action="remove-source" data-idx="${i}" title="Remove">×</button>
    </span>`).join('');

  const officialChips = (s.streamingLinks || []).map((l) => `
    <span class="src-chip" style="--brand:${esc(l.color || brandColor(l.site))}">
      <button class="src-open" data-action="open-url" data-url="${esc(l.url)}" title="${esc(l.url)}">
        <i></i>${esc(l.site)}${l.language ? ` <small>${esc(l.language)}</small>` : ''}
      </button>
      <button class="src-x add" data-action="adopt-link" data-url="${esc(l.url)}" data-site="${esc(l.site)}" title="Add to my sources">+</button>
    </span>`).join('');

  /* franchise groupings for tabs + rails
     (frv 2 added per-entry dub flags; frv 3 adds relation types, which is
     what separates a reboot from a sequel — older saves re-walk once) */
  const fr = root.franchise;
  if (!fr || (root.frv || 0) < FRV_RELATIONS) upgradeFranchise(root);
  if (s.trailer === undefined) upgradeTrailer(s);
  /* seasonEntriesOf narrows the franchise to THIS continuity before anything
     is numbered. Without it The Slime Diaries — a TV spin-off — becomes
     "Season 3" and pushes the real seasons 3 and 4 down to 4 and 5. */
  const folded = fr ? foldedSeasons(seasonEntriesOf(fr, root.id)) : [];

  const seasonTabs = folded.length > 1 ? `
    <div class="season-tabs">
      ${folded.map((se) => {
        const cur = se.parts.some((p) => p.id === s.id);
        const total = se.parts.reduce((a, p) => a + (p.episodes || 0), 0);
        const done = se.parts.reduce((a, p) => a + seasonDone(root, p.id, p.episodes || 0), 0);
        const pct = total ? Math.round((done / total) * 100) : 0;
        const full = total > 0 && done >= total;
        const dub = se.parts.some((p) => p.dub || (peekCache.get(p.id)?.dubLanguages || []).includes('English')
          || (p.id === root.id && (root.dubLanguages || []).includes('English')));
        const label = se.num ? `Season ${se.num}` : esc((se.parts[0].title || '?').slice(0, 24));
        return `<button class="season-pill ${cur ? 'on' : ''}" data-media="${se.parts.map((p) => p.id).join(' ')}"
          ${cur ? '' : `data-action="view-related" data-id="${se.parts[0].id}"`}>
          ${full ? '✓ ' : ''}${label}${se.parts[0].year ? `<small>${se.parts[0].year}</small>` : ''}${dub ? '<em class="p-dub">DUB</em>' : ''}
          ${pct > 0 && !full ? `<i class="pp" style="width:${pct}%"></i>` : ''}
        </button>`;
      }).join('')}
    </div>` : '';

  /* every cour of the season being viewed renders as ONE season — parts the
     TVDB pipeline handed identical lists (it folds cours too) collapse away */
  const activeSeason = folded.find((se) => se.parts.some((p) => p.id === s.id));
  const partRecs = (activeSeason ? activeSeason.parts : [{ id: s.id }]).map((p) =>
    p.id === s.id ? s : (p.id === root.id ? root : peekCache.get(p.id) || p));
  const renderParts = [];
  for (const p of partRecs) {
    const prev = renderParts[renderParts.length - 1]?.rec;
    const a = prev?.episodesList, b = p.episodesList;
    const dupe = a && b && a.length && a.length === b.length &&
      a[0]?.title === b[0]?.title && a[a.length - 1]?.title === b[b.length - 1]?.title;
    if (dupe) continue;
    renderParts.push({ rec: p, loaded: p.id === s.id || !!p.episodesList });
  }
  const epParts = renderParts.map((x) => x.loaded
    ? { ...episodesHTML(root, x.rec), rec: x.rec, loaded: true }
    : { rec: x.rec, loaded: false });
  const ep = {
    badge: `${renderParts.reduce((a, x) => a + epCount(x.rec), 0)} EPISODES${s.epSources ? ` · ${esc(s.epSources)}` : ''}`,
    body: epParts.map((x, i) => `
      ${epParts.length > 1 ? `<p class="part-div">PART ${i + 1}${x.rec.year ? ` · ${x.rec.year}` : ''}${x.rec.episodes ? ` · ${x.rec.episodes} EP` : ''}</p>` : ''}
      ${x.loaded
        ? x.body
        : `<p class="no-eps part-wait"><span class="spinner mini"></span> LOADING PART ${i + 1}…</p>`}`).join('')
  };
  /* A split cour renders BOTH parts at once, but only the viewed record was
     ever version-checked — so Part 2 kept episode data written before the
     TVDB air-date alignment and showed Part 1's stills against its own
     (correct) titles. Every part on screen gets checked. */
  for (const x of epParts) {
    if (x.loaded && (x.rec.epv || 0) < EP_VERSION) upgradeEpisodes(x.rec);
  }

  /* unloaded cours fetch themselves, then the page re-renders */
  for (const x of epParts) {
    if (x.loaded) continue;
    fetchPeek(x.rec.id).then(() => {
      if (viewId === s.id && detailScreen.classList.contains('active')) {
        const st = detailScreen.scrollTop;
        renderDetail();
        detailScreen.scrollTop = st;
      }
    }).catch(() => {});
  }
  const seasonParts = activeSeason ? activeSeason.parts : [{ id: s.id, episodes: epCount(s) }];
  const epTotal = seasonParts.reduce((a, p) => a + (p.episodes || ((p.id === s.id && epCount(s)) || 0)), 0);
  const epDone = seasonParts.reduce((a, p) => a + seasonDone(root, p.id, p.episodes || 0), 0);
  const seasonComplete = epTotal > 0 && epDone >= epTotal;
  const prog = showProgress(root);
  const metaLine = [fmtFormat(s.format), s.year, s.episodes ? `${s.episodes} EP` : '', s.duration ? `${s.duration} MIN` : '', s.studios?.[0]]
    .filter(Boolean).join(' · ');

  setAmbient(heroImg);
  patchHTML(detailScreen, `
  <section class="detail" style="--show:${esc(showColor)}">
    <div class="d-backdrop" style="background-image:url('${esc(heroImg)}')"></div>
    <div class="d-fore">
      <!-- Sticky chrome: starts transparent over the artwork and turns into a
           real bar once the hero scrolls past, so Back and the actions are
           always reachable instead of scrolling away. -->
      <div class="d-topbar">
        <button class="glass-btn" data-action="back">${icon('arrow-left')} ${owned ? 'Library' : 'Back'}</button>
        <span class="dtb-title">${esc(s.title)}</span>
        <div class="hero-actions">
          ${s.trailer?.id ? `<button class="glass-btn" data-action="open-trailer" data-yt="${esc(s.trailer.id)}">${icon('play')} Trailer</button>` : ''}
          ${owned ? `<button class="glass-btn icon-only fav-btn ${root.favourite ? 'on' : ''}" data-action="toggle-fav"
            title="${root.favourite ? 'Unfavourite' : 'Add to favourites'}">${icon(root.favourite ? 'heart-fill' : 'heart')}</button>
          <button class="glass-btn icon-only" data-action="hero-menu" title="Options">${icon('dots-three')}</button>`
          : `<button class="glass-btn add-shelf" data-action="preview-add" data-id="${detailId}">${icon('plus')} Add to shelf</button>`}
        </div>
      </div>
      <div class="hero">
        <img class="hero-banner ${hasBanner ? '' : 'from-cover'}" src="${esc(heroImg)}" alt="">
        <div class="hero-fade"></div>
        ${s.native ? `<div class="hero-jp">${esc(s.native)}</div>` : ''}
      </div>

      <div class="hero-foot">
        <div class="dh-poster"><img src="${esc(viewId === detailId ? (root.artCover || root.cover) : s.cover)}" alt=""></div>
        <div class="hero-title">
          <h1>${esc(s.title)}</h1>
          <div class="ht-meta">
            <span>${esc(metaLine)}</span>
            ${s.score ? `<span class="star">★ ${(s.score / 10).toFixed(1)}</span>` : ''}
            ${dubbed ? `<span class="meta-chip dub">EN DUB</span>` : ''}
            ${(() => {
              const n = root.local?.map?.[s.id] ? Object.keys(root.local.map[s.id]).length : 0;
              return n ? `<span class="meta-chip local">${n} ON DISK</span>` : '';
            })()}
            ${airing ? `<span class="meta-chip airing">${esc(airing)}</span>` : ''}
            <span id="watch-chip">${prog.total && prog.done >= prog.total
              ? `<span class="meta-chip watched">✓ WATCHED</span>`
              : prog.done > 0 ? `<span class="wprog">${prog.done}/${prog.total || '?'} WATCHED</span>` : ''}</span>
          </div>
          ${s.genres?.length ? `<div class="genres">${s.genres.map((g) => `<span class="genre">${esc(g)}</span>`).join('')}</div>` : ''}
          ${s.tags?.length ? `<div class="genres tagrow">${s.tags.map((t) => `
            <button class="genre tagch" data-action="tag-jump" data-tag="${esc(t)}" title="Show everything tagged ${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="d-body">
        <div class="action-bar">
          <div class="action-row">
            ${cta ? `<button class="watch-cta" style="--brand:${esc(ctaBrand)};--brand-text:${brandText(ctaBrand)}" data-action="open-url" data-url="${esc(cta.url)}">${icon('play')} ${esc(cta.label)}</button>` : ''}
            ${owned ? srcChips + '<button class="add-src" data-action="open-source-modal">+ Add source</button>' : ''}
          </div>
          ${officialChips ? `<div class="avail-row"><span class="lbl">Available on</span>${officialChips}</div>` : ''}
        </div>

        <div class="d-cols">
          <div class="d-main">
            ${synopsisHTML(s)}

            <div class="dsec">
              ${seasonTabs}
              <h3 class="sh">Episodes <span class="cnt">${ep.badge}</span>
                ${epTotal ? `<span class="grow"></span>
                <button class="btn-ghost mini" id="season-toggle" data-action="toggle-season"
                  data-parts="${seasonParts.map((p) => `${p.id}:${p.episodes || ((p.id === s.id && epCount(s)) || 0)}`).join(',')}">
                  ${seasonComplete ? '✓ Watched — unmark' : 'Mark season watched'}
                </button>` : ''}
              </h3>
              ${ep.body}
            </div>

            ${watchOrderHTML(fr, root, s)}
            ${!fr ? `
            <div class="dsec">
              <h3 class="sh">Franchise <span class="cnt"><span class="spinner mini"></span> MAPPING SEASONS…</span></h3>
              <div class="rail-scroll">${Array.from({ length: 6 }, () =>
                `<div class="rel-card"><div class="rel-cover skel"></div><p class="skel skel-line"></p></div>`).join('')}</div>
            </div>` : ''}
          </div>
          <aside class="d-rail">${sideRailHTML(s)}</aside>
        </div>
      </div>
    </div>
  </section>`);

  const desc = $('#desc');
  if (desc && desc.scrollHeight <= desc.clientHeight + 4) {
    desc.classList.remove('clamped');
    $('[data-action="toggle-desc"]', detailScreen)?.remove();
  }
  requestAnimationFrame(updateRailNavs);
  updateChrome();

  /* dub schedule for the viewed season (airing shows) */
  upgradeDubSched(s, () => {
    if (viewId === s.id && detailScreen.classList.contains('active')) {
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
    }
  });

  /* quietly build the art pool so the hero upgrades to original-res art */
  prefetchArtPool(root, () => {
    if (detailId === root.id && detailScreen.classList.contains('active')) {
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
    }
  });
}

/* update the watched indicators in place after a single-episode toggle */
function refreshWatchedUI(root) {
  const s = getViewRecord();
  if (!s) return;
  /* folded-season totals come from the toggle button's parts list */
  const btn = $('#season-toggle', detailScreen);
  const parts = (btn?.dataset.parts || `${s.id}:${epCount(s)}`)
    .split(',').map((x) => x.split(':').map(Number)).filter(([id, t]) => id && t > 0);
  const epTotal = parts.reduce((a, [, t]) => a + t, 0);
  const epDone = parts.reduce((a, [id, t]) => a + seasonDone(root, id, t), 0);
  const seasonComplete = epTotal > 0 && epDone >= epTotal;

  if (btn) btn.textContent = seasonComplete ? '✓ Watched — unmark' : 'Mark season watched';

  const pill = $(`.season-pill[data-media~="${s.id}"]`, detailScreen);
  if (pill) {
    const pct = epTotal ? Math.round((epDone / epTotal) * 100) : 0;
    let bar = pill.querySelector('.pp');
    if (seasonComplete && bar) bar.remove();
    else if (!seasonComplete && pct > 0) {
      if (!bar) { bar = document.createElement('i'); bar.className = 'pp'; pill.appendChild(bar); }
      bar.style.width = pct + '%';
    } else if (bar && pct === 0) bar.remove();
  }

  const chip = $('#watch-chip', detailScreen);
  if (chip) {
    const prog = showProgress(root);
    chip.innerHTML = prog.total && prog.done >= prog.total
      ? `<span class="meta-chip watched">✓ WATCHED</span>`
      : prog.done > 0 ? `<span class="wprog">${prog.done}/${prog.total || '?'} WATCHED</span>` : '';
  }
}

/* hide rail arrows when the rail doesn't overflow (shelf + detail) */
/* A rail's edge fade should describe where you actually are in it. The mask
   used to be unconditional, so a Watch-order row of four titles that fits
   comfortably still had its first card dimmed at the left edge for no reason. */
function updateRailNav(w) {
  const sc = w.querySelector('.rail-scroll');
  if (!sc) return;
  const scrolls = sc.scrollWidth > sc.clientWidth + 4;
  w.classList.toggle('no-scroll', !scrolls);
  w.classList.toggle('at-start', !scrolls || sc.scrollLeft <= 2);
  w.classList.toggle('at-end', !scrolls || sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2);
}
function updateRailNavs() { $$('.rail-wrap').forEach(updateRailNav); }
window.addEventListener('resize', updateRailNavs);
/* delegated + capturing: rails are rebuilt by patches, this listener isn't */
for (const screen of [shelfScreen, detailScreen]) {
  screen.addEventListener('scroll', (e) => {
    const sc = e.target;
    if (!sc.classList?.contains('rail-scroll')) return;
    const w = sc.closest('.rail-wrap');
    if (w) updateRailNav(w);
  }, { passive: true, capture: true });
}

/* Sticky detail chrome. The class goes on #screen-detail, which patches never
   touch (patchHTML is childrenOnly) — putting it on .detail would let the next
   re-render wipe it mid-scroll. */
{
  let ticking = false;
  detailScreen.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const hero = detailScreen.querySelector('.hero');
      const trigger = hero ? Math.max(120, hero.offsetHeight - 96) : 240;
      detailScreen.classList.toggle('stuck', detailScreen.scrollTop > trigger);
    });
  }, { passive: true });
}

/* ———————————————————— add / mutate ———————————————————— */
/* Add a show; if it belongs to a franchise already on the shelf it merges
   into that show. Returns the surviving library root. */
async function addById(mediaId) {
  const existing = library.find((x) => x.id === mediaId);
  if (existing) return existing;
  let record = await enrichShow(mediaId);
  /* Land on the show, not on the part you happened to pick out of search.
     The franchise is known by now, so if this entry is a later season or a
     film, shelve season 1 instead — the rest stay in the watch order. */
  const primary = franchisePrimary(record.franchise);
  if (primary && primary.id !== mediaId && !library.some((x) => x.id === primary.id)) {
    record = await enrichShow(primary.id);
    toast(`Added ${record.title} — the whole franchise is in its watch order`);
  }
  library.push(record);
  consolidateLibrary();
  persist();
  return library.find((x) => franchiseIds(x).has(record.id)) || record;
}

/* Fast add: skip the episode merge (the background upgraders fill that in
   place) and land on the page.

   The franchise walk, however, happens UP FRONT rather than in the
   background, because it decides WHICH show you land on. Search for
   "Fate/stay night" and most of what comes back is Unlimited Blade Works;
   picking one and being dropped into season 4 of a show you meant to start is
   the wrong outcome. The walk isn't wasted work either — the record needs a
   franchise regardless, so this only moves it earlier. */
async function addByIdFast(mediaId, { wholeFranchise = false } = {}) {
  const existing = library.find((x) => x.id === mediaId);
  if (existing) return existing;
  const merged = library.find((x) => franchiseIds(x).has(mediaId));
  if (merged) return merged;

  let id = mediaId;
  let franchise = [];

  /* fetchFranchise walks the relation graph, and every hop is a request
     through a 30/min limiter — for something like Fate or Gundam that is
     most of a minute before anything appears on screen. It is only needed
     up-front when the whole franchise was asked for, because that is what
     decides WHICH record to create. For a single show it can finish after
     the page is already open. */
  if (wholeFranchise) {
    try {
      franchise = await fetchFranchise(mediaId);
      /* Only resolve to season 1 when the whole franchise was asked for.
         Silently swapping the pick for its earliest sibling fixes the "I meant
         Fate/stay night" case but breaks the opposite one — sometimes you
         really do want Unlimited Blade Works and nothing else. The choice is
         now made at the search row, where the intent actually is. */
      const primary = franchisePrimary(franchise);
      if (primary && primary.id !== mediaId) {
        const owned = library.find((x) => x.id === primary.id);
        if (owned) return owned;
        id = primary.id;
      }
    } catch { /* no franchise: add exactly what was asked for */ }
  }

  const record = await enrichShowBase(id);
  if (franchise.length) { record.franchise = franchise; record.frv = 2; }
  else record.enriching = 1;                 // seasons still on their way
  autoAdoptSources(record);
  library.push(record);
  consolidateLibrary();
  persist();
  if (record.enriching) window.hikariJobs.add('franchise', { id: record.id },
    { key: 'franchise:' + record.id, priority: 'interactive', label: 'Seasons · ' + record.title });
  if (id !== mediaId) toast(`Added ${record.title} — every season is in its watch order`);
  return library.find((x) => franchiseIds(x).has(id)) || record;
}

/* ———————————————————— search palette ———————————————————— */
const searchModal = $('#searchModal');
const searchInput = $('#searchInput');
const searchResults = $('#searchResults');
const searchSpinner = $('#searchSpinner');
const IDLE_HTML = '<p class="search-idle">TYPE A TITLE — RESULTS APPEAR AS YOU TYPE</p>';

let searchTimer = null;
let currentResults = [];
let collapsedResults = []; // what's actually rendered (seasons folded together)
let activeIdx = -1;
let addBusy = false;
let searchAbort = null;
let searchSeq = 0;
const searchCache = new Map();

function openSearch() {
  searchModal.hidden = false;
  requestAnimationFrame(() => {
    searchModal.classList.add('on');
    searchInput.focus();
  });
}
function closeSearch() {
  searchModal.classList.remove('on');
  setTimeout(() => {
    searchModal.hidden = true;
    searchInput.value = '';
    searchResults.innerHTML = IDLE_HTML;
    currentResults = [];
    activeIdx = -1;
  }, 200);
}

/* strip season markers so "X" and "X Season 2" collapse to one result —
   adding any season lands the whole franchise anyway */
function seasonlessKey(m) {
  return (m.title.english || m.title.romaji || '')
    .toLowerCase()
    .replace(/(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season)(?:\s*(?:part|cour)\s*\d+)?/gi, ' ')
    .replace(/\b(?:part|cour)\s*\d+\b/gi, ' ')
    .replace(/\bfinal\s+season\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || `#${m.id}`;
}

function renderResults() {
  if (!currentResults.length) {
    searchResults.innerHTML = '<p class="search-none">NO RESULTS — TRY ANOTHER TITLE</p>';
    return;
  }
  /* franchise-wide shelf membership — a season of an owned show IS on shelf */
  const shelfIds = new Set();
  for (const r of library) franchiseIds(r).forEach((id) => shelfIds.add(id));

  /* collapse same-franchise seasons; keep AniList's relevance order */
  const groups = [];
  const byKey = new Map();
  for (const m of currentResults) {
    const k = seasonlessKey(m);
    const onShelf = shelfIds.has(m.id);
    let g = byKey.get(k);
    if (!g) {
      g = { rep: m, count: 1, onShelf, repOnShelf: onShelf };
      byKey.set(k, g);
      groups.push(g);
      continue;
    }
    g.count++;
    g.onShelf = g.onShelf || onShelf;
    /* better representative: on-shelf beats not, then TV, then earliest year */
    const better =
      (onShelf && !g.repOnShelf) ||
      (onShelf === g.repOnShelf && (
        (m.format === 'TV' && g.rep.format !== 'TV') ||
        (m.format === g.rep.format && (m.seasonYear || 9999) < (g.rep.seasonYear || 9999))
      ));
    if (better) { g.rep = m; g.repOnShelf = onShelf; }
  }
  collapsedResults = groups.map((g) => g.rep);

  searchResults.innerHTML = groups.map((g, i) => {
    const m = g.rep;
    const title = m.title.english || m.title.romaji || m.title.native || '?';
    const meta = [fmtFormat(m.format), m.seasonYear, m.episodes ? `${m.episodes} EP` : '', m.averageScore ? `★ ${(m.averageScore / 10).toFixed(1)}` : '']
      .filter(Boolean).join(' · ');
    const dub = (m.characters?.edges || []).some((e) => e.voiceActors?.length);
    return `
    <button class="result ${i === activeIdx ? 'active' : ''}" data-idx="${i}" style="animation-delay:${i * 24}ms">
      <span class="result-cover">${m.coverImage?.large ? `<img src="${esc(m.coverImage.large)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <span class="result-info">
        <span class="result-title"><span class="tt">${esc(title)}</span>${g.count > 1 ? `<i class="r-seasons">${g.count} SEASONS</i>` : ''}${dub ? '<i class="r-dub">EN DUB</i>' : ''}</span>
        <span class="result-meta">${esc(meta)}</span>
      </span>
      ${g.onShelf
        ? '<span class="result-badge inlib">ON SHELF</span>'
        : `<span class="result-adds">
             <span class="result-badge" data-add="one" title="Add only this entry">+ SHOW</span>
             <span class="result-badge alt" data-add="all" title="Add the whole franchise, starting at season 1">+ FRANCHISE</span>
             <span class="result-badge ghost" data-add="peek" title="Open its page without adding it">DETAILS</span>
           </span>`}
    </button>`;
  }).join('');
}

async function runSearch(q) {
  const key = q.toLowerCase();

  /* repeats are free — serve from the session cache */
  if (searchCache.has(key)) {
    currentResults = searchCache.get(key);
    activeIdx = currentResults.length ? 0 : -1;
    renderResults();
    return;
  }

  /* cancel whatever's in flight; ignore stale responses */
  searchAbort?.abort();
  const ctrl = new AbortController();
  searchAbort = ctrl;
  const seq = ++searchSeq;

  searchSpinner.hidden = false;
  try {
    const results = await searchAnime(q, ctrl.signal);
    if (seq !== searchSeq) return;
    searchCache.set(key, results);
    if (searchCache.size > 80) searchCache.delete(searchCache.keys().next().value);
    currentResults = results;
    activeIdx = results.length ? 0 : -1;
    renderResults();
  } catch (err) {
    if (err.name === 'AbortError' || seq !== searchSeq) return;
    searchResults.innerHTML = `<p class="search-none">${esc(err.message.toUpperCase())}</p>`;
  } finally {
    if (seq === searchSeq) searchSpinner.hidden = true;
  }
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults.innerHTML = IDLE_HTML;
    currentResults = [];
    activeIdx = -1;
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 480);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!collapsedResults.length) return;
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + collapsedResults.length) % collapsedResults.length;
    renderResults();
    $(`.result[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeIdx >= 0) pickResult(activeIdx, { wholeFranchise: e.shiftKey });
  }
});

searchResults.addEventListener('click', (e) => {
  const row = e.target.closest('.result');
  if (!row) return;
  /* the row itself still adds the single show — the franchise is the
     deliberate, second click */
  const which = e.target.closest('[data-add]')?.dataset.add;
  if (which === 'peek') {
    const m = collapsedResults[+row.dataset.idx];
    if (m) { closeSearch(); goPreview(m.id); }
    return;
  }
  pickResult(+row.dataset.idx, { wholeFranchise: which === 'all' });
});

async function pickResult(idx, { wholeFranchise = false } = {}) {
  if (addBusy) return;
  const m = collapsedResults[idx];
  if (!m) return;

  /* on shelf — directly or as a season of an owned franchise */
  const owner = library.find((x) => x.id === m.id)
    || library.find((x) => franchiseIds(x).has(m.id));
  if (owner) {
    closeSearch();
    goDetail(owner.id);
    if (owner.id !== m.id) switchView(m.id).catch(() => {});
    return;
  }

  addBusy = true;
  const row = $(`.result[data-idx="${idx}"]`);
  if (row) {
    row.classList.add('busy');
    row.querySelector('.result-badge').textContent = 'ADDING…';
  }
  try {
    const record = await addByIdFast(m.id, { wholeFranchise });
    closeSearch();
    goDetail(record.id);
    if (record.id !== m.id) {
      toast(`Merged into “${record.title}” on your shelf`);
      switchView(m.id).catch(() => {});
    } else {
      toast(`Added “${record.title}”`);
    }
  } catch (err) {
    toast(`Could not add — ${err.message}`, 'err');
    if (row) {
      row.classList.remove('busy');
      row.querySelector('.result-badge').textContent = '+ ADD';
    }
  } finally {
    addBusy = false;
  }
}

/* ———————————————————— source modal ———————————————————— */
const sourceModal = $('#sourceModal');
const sourceName = $('#sourceName');
const sourceUrl = $('#sourceUrl');

function buildBrandGrid() {
  $('#brandGrid').innerHTML = BRANDS.map((b) => `
    <button class="brand-btn ${selectedBrand === b.name ? 'on' : ''}" data-brand="${esc(b.name)}" style="--brand:${b.color}">
      <i></i>${esc(b.name)}
    </button>`).join('');
}

$('#brandGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.brand-btn');
  if (!btn) return;
  selectedBrand = btn.dataset.brand;
  buildBrandGrid();
  if (selectedBrand !== 'Other') sourceName.value = selectedBrand;
  else { sourceName.value = ''; sourceName.focus(); }
});

function openSourceModal(showId) {
  sourceModalShowId = showId;
  selectedBrand = null;
  sourceName.value = '';
  sourceUrl.value = '';
  buildBrandGrid();
  sourceModal.hidden = false;
  requestAnimationFrame(() => {
    sourceModal.classList.add('on');
    sourceUrl.focus();
  });
}
function closeSourceModal() {
  sourceModal.classList.remove('on');
  setTimeout(() => { sourceModal.hidden = true; }, 200);
}

function saveSource() {
  const s = library.find((x) => x.id === sourceModalShowId);
  if (!s) return;
  const name = sourceName.value.trim();
  let url = sourceUrl.value.trim();
  if (!name) { toast('Give the source a name', 'err'); sourceName.focus(); return; }
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!url || !/^https?:\/\/.+\..+/.test(url)) { toast('Enter a valid URL', 'err'); sourceUrl.focus(); return; }
  s.sources = s.sources || [];
  s.sources.push({ name, url });
  persist();
  closeSourceModal();
  renderDetail();
  toast(`${name} added as a source`);
}

sourceUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSource(); });
sourceName.addEventListener('keydown', (e) => { if (e.key === 'Enter') sourceUrl.focus(); });

/* ———————————————————— artwork picker ———————————————————— */
const artModal = $('#artModal');
let artTargetId = null;

function artCandidates(root) {
  const covers = [...new Set([
    root.cover,
    ...(root.franchise || []).map((f) => f.cover),
    ...Object.values(root.peek || {}).map((p) => p.cover),
    ...(root.artPool?.covers || [])
  ].filter(Boolean))].slice(0, 48);
  const banners = [...new Set([
    root.banner,
    ...(root.franchise || []).map((f) => f.banner),
    ...Object.values(root.peek || {}).map((p) => p.banner),
    ...(root.artPool?.banners || [])
  ].filter(Boolean))].slice(0, 30);
  return { covers, banners };
}

let artKind = 'cover';
let artIdx = 0;

function artCurrentUrl(root, kind) {
  return kind === 'cover' ? (root.artCover || root.cover) : (root.artBanner || root.banner || '');
}

function artTabsHTML(nCovers, nBanners) {
  return `
    <div class="seg">
      <button class="${artKind === 'cover' ? 'on' : ''}" data-action="art-tab" data-kind="cover">Cover · ${nCovers}</button>
      <button class="${artKind === 'banner' ? 'on' : ''}" data-action="art-tab" data-kind="banner">Banner · ${nBanners}</button>
    </div>`;
}

function renderArtRows(root) {
  const { covers, banners } = artCandidates(root);
  const list = artKind === 'cover' ? covers : banners;
  if (!list.length) {
    $('#artBody').innerHTML = `
      <div class="art-tabs">${artTabsHTML(covers.length, banners.length)}</div>
      <p class="no-eps" style="padding:44px 0;text-align:center">No ${artKind} candidates for this show.</p>`;
    return;
  }
  artIdx = Math.min(Math.max(artIdx, 0), list.length - 1);
  const url = list[artIdx];
  const current = artCurrentUrl(root, artKind);
  const isCurrent = url === current;

  $('#artBody').innerHTML = `
    <div class="art-tabs">${artTabsHTML(covers.length, banners.length)}</div>
    <div class="art-stage ${artKind}">
      <button class="rail-nav prev" data-action="art-prev" aria-label="Previous">${icon('caret-left')}</button>
      <img src="${esc(url)}" alt="">
      <button class="rail-nav next" data-action="art-next" aria-label="Next">${icon('caret-right')}</button>
      ${isCurrent ? `<span class="art-current">${icon('check')} IN USE</span>` : ''}
    </div>
    <div class="rail-wrap art-strip-wrap">
      <button class="rail-nav prev" data-action="rail" data-dir="prev" aria-label="Scroll thumbnails left">${icon('caret-left')}</button>
      <div class="rail-scroll art-strip">
        ${list.map((u, i) => `
        <button class="art-thumb ${artKind} ${i === artIdx ? 'on' : ''} ${u === current ? 'used' : ''}" data-action="art-jump" data-i="${i}">
          <img src="${esc(u)}" loading="lazy" alt="">
        </button>`).join('')}
      </div>
      <button class="rail-nav next" data-action="rail" data-dir="next" aria-label="Scroll thumbnails right">${icon('caret-right')}</button>
    </div>
    <div class="art-foot">
      <span class="art-count">${artIdx + 1} / ${list.length}</span>
      <div class="art-foot-btns">
        <button class="btn-ghost" data-action="close-art-modal">Done</button>
        <button class="btn-primary" data-action="art-apply" ${isCurrent ? 'disabled' : ''}>
          ${isCurrent ? '✓ Current' : `Use as ${artKind}`}
        </button>
      </div>
    </div>`;
  $(`.art-thumb[data-i="${artIdx}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

/* surgical selection update — never rebuilds the strip (no scroll jumps) */
function updateArtSelection(root, opts = {}) {
  const { covers, banners } = artCandidates(root);
  const list = artKind === 'cover' ? covers : banners;
  if (!list.length || !$('.art-stage img')) { renderArtRows(root); return; }
  artIdx = Math.min(Math.max(artIdx, 0), list.length - 1);
  const url = list[artIdx];
  const current = artCurrentUrl(root, artKind);
  const isCurrent = url === current;

  $('.art-stage img').src = url;

  const stage = $('.art-stage');
  let tag = $('.art-current', stage);
  if (isCurrent && !tag) {
    tag = document.createElement('span');
    tag.className = 'art-current';
    tag.innerHTML = `${icon('check')} IN USE`;
    stage.appendChild(tag);
  } else if (!isCurrent && tag) {
    tag.remove();
  }

  $$('.art-thumb').forEach((t) => {
    const i = +t.dataset.i;
    t.classList.toggle('on', i === artIdx);
    t.classList.toggle('used', list[i] === current);
  });

  const cnt = $('.art-count');
  if (cnt) cnt.textContent = `${artIdx + 1} / ${list.length}`;
  const ap = $('[data-action="art-apply"]');
  if (ap) {
    ap.disabled = isCurrent;
    ap.textContent = isCurrent ? '✓ Current' : `Use as ${artKind}`;
  }
  if (opts.scrollThumb) {
    $(`.art-thumb[data-i="${artIdx}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
}

function artApplyCurrent() {
  const root = library.find((x) => x.id === artTargetId);
  if (!root) return;
  const { covers, banners } = artCandidates(root);
  const list = artKind === 'cover' ? covers : banners;
  const url = list[artIdx];
  if (!url) return;
  if (artKind === 'cover') {
    if (url === root.cover) delete root.artCover; else root.artCover = url;
  } else {
    if (url === (root.banner || '')) delete root.artBanner; else root.artBanner = url;
  }
  persist();
  updateArtSelection(root);
  if (shelfScreen.classList.contains('active')) renderShelf();
  else { const st = detailScreen.scrollTop; renderDetail(); detailScreen.scrollTop = st; }
}

async function openArtModal(rootId) {
  const root = library.find((x) => x.id === rootId);
  if (!root) return;
  artTargetId = rootId;
  artKind = 'cover';
  artIdx = 0;
  renderArtRows(root);
  artModal.hidden = false;
  requestAnimationFrame(() => artModal.classList.add('on'));

  /* sweep once — and re-sweep whenever the set of configured keys changes */
  const keys = { tmdb: appSettings.tmdbKey || '', fanart: appSettings.fanartKey || '' };
  const stamp = artStamp();
  if (!root.artPool || root.artPool.stamp !== stamp) {
    const note = $('#artLoading');
    if (note) note.hidden = false;
    try {
      const ids = [root.id, ...(root.franchise || []).map((f) => f.id)];
      /* the user is sitting in front of the picker waiting — do not let this
         queue behind a background franchise crawl */
      const pool = await fetchArtPool(ids, root.idMal, keys, { bg: false });
      pool.stamp = stamp;
      root.artPool = pool;
      persist();
      if (!artModal.hidden && artTargetId === rootId) renderArtRows(root);
    } catch { /* keep the basic candidates */ }
    if (note) note.hidden = true;
  }
}
function closeArtModal() {
  artModal.classList.remove('on');
  setTimeout(() => { artModal.hidden = true; }, 200);
}
artModal.addEventListener('click', (e) => { if (e.target === artModal) closeArtModal(); });

/* strip: wheel scrolls horizontally; stage: wheel steps prev/next */
let stageWheelAt = 0;
artModal.addEventListener('wheel', (e) => {
  const strip = e.target.closest('.art-strip');
  if (strip) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
    return;
  }
  const stage = e.target.closest('.art-stage');
  if (stage && Math.abs(e.deltaY) > 4) {
    const now = performance.now();
    if (now - stageWheelAt < 140) return;
    stageWheelAt = now;
    const root = library.find((x) => x.id === artTargetId);
    if (!root) return;
    const { covers, banners } = artCandidates(root);
    const n = (artKind === 'cover' ? covers : banners).length;
    if (!n) return;
    artIdx = (artIdx + (e.deltaY > 0 ? 1 : -1) + n) % n;
    updateArtSelection(root, { scrollThumb: true });
    e.preventDefault();
  }
}, { passive: false });

/* strip: drag-to-scroll (suppresses the click that would jump) */
let stripDrag = null;
let stripDragged = false;
artModal.addEventListener('pointerdown', (e) => {
  const strip = e.target.closest('.art-strip');
  if (!strip || e.button !== 0) return;
  stripDrag = { strip, x: e.clientX, left: strip.scrollLeft };
  stripDragged = false;
});
window.addEventListener('pointermove', (e) => {
  if (!stripDrag) return;
  const dx = e.clientX - stripDrag.x;
  if (Math.abs(dx) > 5) {
    stripDragged = true;
    stripDrag.strip.classList.add('dragging');
  }
  if (stripDragged) stripDrag.strip.scrollLeft = stripDrag.left - dx;
});
window.addEventListener('pointerup', () => {
  if (!stripDrag) return;
  stripDrag.strip.classList.remove('dragging');
  stripDrag = null;
  if (stripDragged) setTimeout(() => { stripDragged = false; }, 0);
});

/* ———————————————————— settings ———————————————————— */
const settingsModal = $('#settingsModal');
let settingsTab = 'artwork';

function switchSettingsTab(name) {
  settingsTab = name;
  $$('.set-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.set-sec').forEach((s) => s.classList.toggle('on', s.dataset.sec === name));
}

/* key fields render as xxxx-xxxx-<last4> unless focused or eye-revealed,
   so the settings screen is safe to screenshot */
function keyMaskStr(v) {
  /* google client ids all end in .apps.googleusercontent.com — mask the part that varies */
  const core = v.replace(/\.apps\.googleusercontent\.com$/i, '');
  return core.length > 8 ? `xxxx-xxxx-${core.slice(-4)}` : 'xxxx-xxxx';
}
function syncKeyMask(input) {
  const wrap = input.closest('.key-wrap');
  if (!wrap) return;
  const hide = !!input.value && input.dataset.revealed !== '1' && document.activeElement !== input;
  wrap.querySelector('.key-mask').textContent = hide ? keyMaskStr(input.value) : '';
  wrap.classList.toggle('masked', hide);
  const eye = wrap.querySelector('.key-eye');
  eye.innerHTML = icon(input.dataset.revealed === '1' ? 'eye-slash' : 'eye');
  eye.title = input.dataset.revealed === '1' ? 'Hide' : 'Reveal';
  eye.style.visibility = input.value ? '' : 'hidden';
}
function syncKeyMasks() {
  $$('input[data-mask]').forEach(syncKeyMask);
}
$$('input[data-mask]').forEach((inp) => {
  inp.addEventListener('focus', () => syncKeyMask(inp));
  inp.addEventListener('blur', () => syncKeyMask(inp));
  inp.addEventListener('input', () => syncKeyMask(inp));
});

function openSettings() {
  $('#tmdbKey').value = appSettings.tmdbKey || '';
  $('#fanartKey').value = appSettings.fanartKey || '';
  $('#traceKey').value = appSettings.traceKey || '';
  $('#notifyEps').checked = appSettings.notifyEps !== false;
  $('#autoScan').checked = appSettings.autoScan !== false;
  $('#browsePerLoad').value = String(appSettings.browsePerLoad || 50);
  renderMediaRoots();
  fillAbout();
  fillRemoteBox();          // outside the signed-in block — it works either way
  window.syncUI?.fill();
  syncKeyMasks();
  switchSettingsTab(settingsTab);
  settingsModal.hidden = false;
  requestAnimationFrame(() => settingsModal.classList.add('on'));
}

/* ——— remote-play server box (Sync tab) ———
   The LAN server binds every interface and streams local files to anything
   holding the token, so it needs to be visible and stoppable rather than an
   invisible always-on service. */
let remoteState = null;
async function fillRemoteBox() {
  const box = $('#remoteStats');
  if (!box) return;
  try { remoteState = await window.hikari.remoteInfo(); } catch { remoteState = null; }
  const on = !!remoteState?.running;
  const dot = $('#remoteDot');
  const label = $('#remoteState');
  const tgl = $('#remoteToggle');
  if (dot) dot.className = `remote-dot ${on ? 'on' : ''}`;
  if (label) label.textContent = on ? 'Serving on your local network' : 'Off';
  if (tgl) { tgl.classList.toggle('on', on); tgl.setAttribute('aria-checked', String(on)); }
  const kv = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`;
  const addrs = (remoteState?.ips || []).map((ip) => `http://${ip}:${remoteState.port}`);
  box.innerHTML = on
    ? [
      kv('Address', addrs[0] || `port ${remoteState.port}`),
      addrs.length > 1 ? kv('Also reachable', addrs.slice(1).join('  ·  ')) : '',
      kv('Token', remoteState.token ? `••••${String(remoteState.token).slice(-4)}` : '—'),
      kv('Files shared', `${library.reduce((a, r) => a + (r.local?.map ? countLocalEps(r.local.map) : 0), 0)} episodes on disk`)
    ].filter(Boolean).join('')
    : kv('Status', 'Not listening — the phone can still tick episodes');
}
window.fillRemoteBox = fillRemoteBox;

/* the About tab: version + runtime from main, library stats from here */
function fillAbout() {
  const kvRow = (k, v) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span></div>`;
  const shows = groupEntries(library).length;
  const eps = library.reduce((a, r) => a + epCount(r), 0);
  const watched = library.reduce((a, r) =>
    a + Object.values(r.watched || {}).reduce((x, l) => x + l.length, 0), 0);
  const onDisk = library.reduce((a, r) => a + (r.local?.map ? countLocalEps(r.local.map) : 0), 0);
  $('#aboutStats').innerHTML = [
    kvRow('Shows', `${shows} (${library.length} titles)`),
    kvRow('Episodes tracked', eps.toLocaleString()),
    kvRow('Episodes watched', watched.toLocaleString()),
    ...(onDisk ? [kvRow('Episodes on disk', onDisk.toLocaleString())] : [])
  ].join('');
  window.hikari.appInfo?.().then((i) => {
    if (!i) return;
    $('#aboutVersion').textContent = `v${i.version}`;
    $('#aboutDataDir').textContent = i.dataDir;
    $('#aboutRuntime').innerHTML = [
      kvRow('Hikari', `v${i.version}`),
      kvRow('Electron', i.electron),
      kvRow('Chromium', i.chrome),
      kvRow('Node', i.node)
    ].join('');
  }).catch(() => {});
}
function closeSettings() {
  settingsModal.classList.remove('on');
  setTimeout(() => { settingsModal.hidden = true; }, 200);
}
async function saveSettingsModal() {
  appSettings.tmdbKey = $('#tmdbKey').value.trim();
  appSettings.fanartKey = $('#fanartKey').value.trim();
  appSettings.traceKey = $('#traceKey').value.trim();
  refreshTraceQuota();
  appSettings.notifyEps = $('#notifyEps').checked;
  appSettings.autoScan = $('#autoScan').checked;
  appSettings.browsePerLoad = Number($('#browsePerLoad').value) || 50;
  await window.hikari.saveSettings(appSettings);
  closeSettings();
  toast(appSettings.tmdbKey || appSettings.fanartKey
    ? 'Keys saved — open Artwork on any show to fetch full galleries'
    : 'Settings saved');
}
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

/* ——— backup: export / import ——— */
async function exportLibrary() {
  const payload = {
    app: 'hikari',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { tmdbKey: appSettings.tmdbKey || '', fanartKey: appSettings.fanartKey || '' },
    library
  };
  const res = await window.hikari.exportData(payload);
  if (res?.ok) toast(`Exported ${library.length} title${library.length === 1 ? '' : 's'}`);
  else if (!res?.canceled) toast(`Export failed — ${res?.error || 'unknown error'}`, 'err');
}

async function importLibrary() {
  const res = await window.hikari.importData();
  if (!res?.ok) {
    if (!res?.canceled) toast(`Import failed — ${res?.error || 'unknown error'}`, 'err');
    return;
  }
  const data = res.data;
  if (data?.app !== 'hikari' || !Array.isArray(data.library)) {
    toast('That file is not a Hikari backup', 'err');
    return;
  }

  let added = 0, mergedCount = 0;
  for (const rec of data.library) {
    if (!rec || typeof rec.id !== 'number' || !rec.title) continue;
    const existing = library.find((x) => x.id === rec.id);
    if (existing) {
      for (const [id, list] of Object.entries(rec.watched || {})) {
        const set = new Set([...(watchedMap(existing)[id] || []), ...list]);
        watchedMap(existing)[id] = [...set].sort((a, b) => a - b);
      }
      existing.sources = existing.sources || [];
      for (const src of rec.sources || []) {
        if (!existing.sources.some((x) => x.url === src.url)) existing.sources.push(src);
      }
      if (!existing.artCover && rec.artCover) existing.artCover = rec.artCover;
      if (!existing.artBanner && rec.artBanner) existing.artBanner = rec.artBanner;
      mergedCount++;
    } else {
      library.push(rec);
      for (const [id, p] of Object.entries(rec.peek || {})) peekCache.set(+id, p);
      added++;
    }
  }
  consolidateLibrary();
  persist();

  let keysChanged = false;
  for (const k of ['tmdbKey', 'fanartKey']) {
    if (data.settings?.[k] && !appSettings[k]) { appSettings[k] = data.settings[k]; keysChanged = true; }
  }
  if (keysChanged) window.hikari.saveSettings(appSettings).catch(() => {});

  closeSettings();
  renderShelf();
  showScreen('shelf');
  toast(`Imported — ${added} added, ${mergedCount} merged${keysChanged ? ', keys restored' : ''}`);
}
$('#tmdbKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettingsModal(); });

/* ———————————————————— local media ———————————————————— */
/* episode number extraction — ordered from most to least explicit */
function parseEpFile(name) {
  let n = name.replace(/\.[^.]+$/, '').replace(/[[(][^\])]*[\])]/g, ' ');
  let m;
  if ((m = /s(\d{1,2})[ ._-]*e(\d{1,3})(?:[ ._-]*e?(\d{1,3}))?/i.exec(n))) {
    return { season: +m[1], ep: +m[2], ep2: m[3] ? +m[3] : null, conf: 3 };
  }
  if ((m = /(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?=[^0-9]|$)/.exec(n))) {
    return { season: +m[1], ep: +m[2], ep2: null, conf: 3 };
  }
  if ((m = /(?:^|[^a-z0-9])ep?(?:isode)?[ ._]*(\d{1,3})(?=[^0-9]|$)/i.exec(n))) {
    return { season: null, ep: +m[1], ep2: null, conf: 2 };
  }
  if ((m = /[-_– ]+(\d{1,3})(?:v\d)?\s*$/.exec(n.trim()))) {
    return { season: null, ep: +m[1], ep2: null, conf: 2 };
  }
  const nums = [...n.matchAll(/\d{1,4}/g)].map((x) => +x[0])
    .filter((x) => x > 0 && x < 400 && ![264, 265, 480, 540, 576, 720, 1080].includes(x));
  if (nums.length === 1) return { season: null, ep: nums[0], ep2: null, conf: 1 };
  return { season: null, ep: null, ep2: null, conf: 0 };
}

const normTitle = (t) => String(t || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // Saitō → saito
  .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/* small-typo tolerance ("Acchel World") */
function levDist(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

function groupTitles(g) {
  const out = new Set();
  for (const m of g.members) {
    for (const t of [m.title, m.romaji, ...(m.franchise || []).map((f) => f.title)]) {
      const n = normTitle(t);
      if (n) out.add(n);
    }
  }
  return [...out];
}

function matchShowFolder(folderName, groups) {
  const q = normTitle(folderName);
  if (!q) return null;
  let best = null, score = 0;
  for (const g of groups) {
    for (const n of groupTitles(g)) {
      let s = 0;
      if (n === q) s = 1;
      else if (q.includes(n) || n.includes(q)) {
        s = 0.92 * (Math.min(n.length, q.length) / Math.max(n.length, q.length));
      } else if (n.length > 6 && q.length > 6) {
        const cap = Math.max(2, Math.floor(Math.min(n.length, q.length) / 10));
        const d = levDist(n, q, cap);
        if (d <= cap) s = 0.85 - d * 0.03;
        /* a whole missing word blows the edit-distance cap outright, so fall
           back to comparing word sets (see tokenSubsetScore in api.js) */
        else s = tokenSubsetScore(q.split(' '), n.split(' '));
      }
      if (s > score) { score = s; best = g; }
    }
  }
  return score >= 0.72 ? { group: best, score } : null;
}

/* map a show's scanned folder buckets onto its franchise entries */
function mapBuckets(root, buckets) {
  const seasons = orderedSeasons(root);
  const fr = root.franchise || [];
  const movies = fr.filter((x) => !isSeasonEntry(x) && x.format === 'MOVIE');
  const extras = fr.filter((x) => !isSeasonEntry(x) && x.format !== 'MOVIE');
  const map = {};
  const review = [];
  const put = (mediaId, ep, file) => (((map[mediaId] = map[mediaId] || {})[ep] = map[mediaId][ep] || [])).push(file);
  const flag = (f, why) => review.push({ name: f.name, why });

  for (const b of buckets) {
    if (b.kind === 'season' || b.kind === 'root') {
      for (const f of b.files) {
        const p = parseEpFile(f.name);
        if (!p.ep) { flag(f, 'no episode number recognised'); continue; }
        let sNum = b.kind === 'season' ? b.num : (p.season || 1);
        if (b.kind === 'season' && p.season && p.season !== b.num && p.conf >= 3) {
          flag(f, `filename says S${p.season} but sits in "${b.label}" — using the folder`);
        }
        let season = seasons[sNum - 1];
        let ep = p.ep;
        /* absolute numbering: "Show - 37" in a 12-ep S1 walks across seasons */
        if (season && season.episodes && ep > season.episodes && !p.season) {
          let rem = ep, idx = sNum - 1;
          while (idx < seasons.length && seasons[idx].episodes && rem > seasons[idx].episodes) {
            rem -= seasons[idx].episodes;
            idx++;
          }
          if (idx < seasons.length) { season = seasons[idx]; ep = rem; }
        }
        if (!season) { flag(f, `no season ${sNum} known for this show`); continue; }
        put(season.id, ep, f.path);
        if (p.ep2 && p.ep2 > ep && p.ep2 - ep < 4) {
          for (let k = ep + 1; k <= p.ep2; k++) put(season.id, k, f.path);
        }
      }
    } else if (b.kind === 'movies') {
      for (const f of b.files) {
        const q = normTitle(f.name.replace(/\.[^.]+$/, ''));
        const hit = movies.find((mv) => {
          const n = normTitle(mv.title);
          return n && (q.includes(n) || n.includes(q));
        });
        if (hit) put(hit.id, 1, f.path);
        else flag(f, 'could not match to a movie');
      }
    } else if (b.kind === 'specials' || b.kind === 'mixed') {
      const pool = [...movies, ...extras];
      for (const f of b.files) {
        const base = normTitle(f.name.replace(/\.[^.]+$/, ''));
        /* a movie/OVA usually carries its own title in the filename — trust that first */
        const tHit = pool
          .map((x) => ({ x, n: normTitle(x.title) }))
          .filter(({ n }) => n && n.length >= 8 && base.includes(n))
          .sort((a, b2) => b2.n.length - a.n.length)[0];
        if (tHit) { put(tHit.x.id, 1, f.path); continue; }
        const p = parseEpFile(f.name);
        if (p.ep && extras[p.ep - 1]) put(extras[p.ep - 1].id, 1, f.path);
        else flag(f, 'could not match to a special/OVA/movie');
      }
    } else {
      b.files.forEach((f) => flag(f, `unrecognised folder "${b.label}"`));
    }
  }
  return { map, review };
}

const countLocalEps = (map) => Object.values(map).reduce((a, eps) => a + Object.keys(eps).length, 0);

function localFileFor(root, mediaId, ep) {
  return root?.local?.map?.[mediaId]?.[ep]?.[0] || null;
}

/* ——— scan orchestration ——— */
const scanModal = $('#scanModal');
function scanPhase(html) { $('#scanBody').innerHTML = html; }
function closeScanModal() {
  scanModal.classList.remove('on');
  setTimeout(() => { scanModal.hidden = true; }, 200);
}
scanModal.addEventListener('click', (e) => { if (e.target === scanModal) closeScanModal(); });

function applyShowScan(root, folders) {
  const buckets = folders.flatMap((f) => f.buckets);
  const { map, review } = mapBuckets(root, buckets);
  root.local = { map, dirs: folders.map((f) => f.folder), at: Date.now() };
  syncMediaRoots(); // newly linked folders stay reachable across restarts
  return { title: root.title, eps: countLocalEps(map), review };
}

/* Like applyShowScan, but ADDS to what a show already has instead of
   replacing it. The auto-scan links one newly-appeared folder at a time, and
   a plain replace would silently drop every folder linked before it. */
function applyShowScanMerge(root, folders) {
  const prev = root.local?.map || {};
  const before = countLocalEps(prev);
  const { map, review } = mapBuckets(root, folders.flatMap((f) => f.buckets));
  const merged = {};
  for (const src of [prev, map]) {
    for (const [mid, eps] of Object.entries(src)) {
      const into = (merged[mid] = merged[mid] || {});
      for (const [ep, files] of Object.entries(eps)) {
        into[ep] = [...new Set([...(into[ep] || []), ...files])];
      }
    }
  }
  const added = countLocalEps(merged) - before;
  /* leave the record completely alone when nothing new turned up, so a
     periodic re-scan never dirties the library or triggers a sync push */
  if (added <= 0) return { added: 0, review };
  root.local = {
    map: merged,
    dirs: [...new Set([...(root.local?.dirs || []), ...folders.map((f) => f.folder)])].filter(Boolean),
    at: Date.now()
  };
  syncMediaRoots();
  return { added, review };
}

/* ——— background folder watch ———
   New folders turn up in the media roots whenever something finishes
   downloading; noticing that shouldn't require remembering to open Import.
   Rescan periodically, link whatever confidently matches a show already on
   the shelf, and otherwise stay quiet. */
const AUTOSCAN_EVERY = 15 * 60 * 1000;
const AUTOSCAN_MIN_GAP = 5 * 60 * 1000;
let autoScanning = false;
let autoScanAt = 0;
let autoScanNotified = false;

function linkedDirSet() {
  const s = new Set();
  for (const r of library) for (const d of r.local?.dirs || []) if (d) s.add(String(d).toLowerCase());
  return s;
}

/* ——— folder review queue ———
   A scanned folder that matches nothing on the shelf used to produce a toast
   and nothing else, so new downloads simply never appeared. Now each one is
   identified against AniList: a confident, unambiguous match is added by
   itself; anything less waits here for a decision rather than guessing.

   This is device-local on purpose — media paths already never leave the
   machine (cloudRecord strips `local`), so a review list keyed on folder
   paths has no business in the account either. */
const REVIEW_STORE = 'hikariScan.review.v1';
const AUTO_ADD_MIN = 0.90;      // below this, ask
const AUTO_ADD_LEAD = 0.08;     // ...and the runner-up must be clearly behind

function loadReview() {
  try { return JSON.parse(localStorage.getItem(REVIEW_STORE)) || []; } catch { return []; }
}
function saveReview(list) {
  try { localStorage.setItem(REVIEW_STORE, JSON.stringify(list.slice(0, 300))); } catch {}
  updateChrome();
}
const reviewPending = () => loadReview().filter((r) => r.state === 'pending');
function reviewKnows(folder) {
  const f = String(folder || '').toLowerCase();
  return loadReview().some((r) => String(r.folder).toLowerCase() === f);
}
function reviewResolve(folder, state) {
  const list = loadReview();
  const row = list.find((r) => String(r.folder).toLowerCase() === String(folder).toLowerCase());
  if (row) { row.state = state; row.decidedAt = Date.now(); saveReview(list); }
}

/* how well does an AniList title match what the folder is called? */
function folderMatchScore(folderName, media) {
  const q = normTitle(folderName);
  if (!q) return 0;
  let best = 0;
  for (const t of [media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms || [])]) {
    const n = normTitle(t);
    if (!n) continue;
    let s = 0;
    if (n === q) s = 1;
    else if (q.includes(n) || n.includes(q)) {
      s = 0.92 * (Math.min(n.length, q.length) / Math.max(n.length, q.length));
    } else s = tokenSubsetScore(q.split(' '), n.split(' '));
    if (s > best) best = s;
  }
  return best;
}

async function identifyFolder({ folder, name, buckets }) {
  if (reviewKnows(folder)) return;                       // already decided or waiting
  if (library.some((r) => (r.local?.dirs || []).some((d) => String(d).toLowerCase() === String(folder).toLowerCase()))) return;

  const results = await searchAnime(name);
  /* Anime routinely ships a film, an OVA and a recap sharing the series'
     exact title, so a tie on title score is the normal case, not a sign of
     ambiguity — "Death Note" scores 1.0 three times over. Break the tie the
     way a person would: the TV series is what a folder called Death Note
     means, and popularity settles the rest. */
  const FORMAT_RANK = { TV: 0, TV_SHORT: 1, ONA: 2, OVA: 3, MOVIE: 4, SPECIAL: 5, MUSIC: 6 };
  const rank = (m) => FORMAT_RANK[m.format] ?? 9;
  const scored = results
    .map((m) => ({ media: m, score: folderMatchScore(name, m) }))
    .sort((a, b) => b.score - a.score
      || rank(a.media) - rank(b.media)
      || (b.media.popularity || 0) - (a.media.popularity || 0))
    .slice(0, 6);

  const top = scored[0];
  /* a rival is only a rival if the tie-break did not separate them */
  const rival = scored.slice(1).find((s) => s.score > (top?.score ?? 0) - AUTO_ADD_LEAD
    && rank(s.media) <= rank(top.media));
  const exact = top && top.score >= 0.995;

  if (top && top.score >= AUTO_ADD_MIN && (!rival || (exact && rank(top.media) < rank(rival.media)))) {
    const rec = await addByIdFast(top.media.id);
    if (rec) {
      applyShowScanMerge(rec, [{ folder, name, buckets }]);
      persist();
      toast(`Found “${rec.title}” in your media folders — added`);
      if (shelfScreen.classList.contains('active')) renderShelf();
    }
    return;
  }

  /* not confident enough to decide for them */
  const list = loadReview();
  list.unshift({
    folder, name, state: 'pending', seenAt: Date.now(),
    episodes: (buckets || []).reduce((n, b) => n + (b.files?.length || 0), 0),
    candidates: scored.filter((s) => s.score > 0.3).map(({ media: m, score }) => ({
      id: m.id, score: Math.round(score * 100) / 100,
      title: m.title?.english || m.title?.romaji || m.title?.native || '?',
      year: m.seasonYear || null, format: m.format || '',
      cover: m.coverImage?.large || ''
    }))
  });
  saveReview(list);
}

/* ——— activity panel ———
   The queue is only half the fix; the other half is being able to see it.
   Two silent failures this week (a dead session, a poisoned tombstone list)
   both survived because nothing on screen said work had stopped. */
let jobsPanelOpen = false;

function jobsPillPaint(snap) {
  const pill = document.getElementById('sb-jobs');
  const txt = document.getElementById('sb-jobs-txt');
  if (!pill || !txt) return;
  const waiting = reviewPending().length;
  const busy = snap.running ? 1 : 0;
  const total = snap.pending + busy;
  if (!total && !waiting && !snap.failed) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.classList.toggle('working', !!snap.running);
  pill.classList.toggle('warn', !!waiting || !!snap.failed);
  txt.textContent = waiting ? `${waiting} TO REVIEW`
    : snap.failed ? `${snap.failed} FAILED`
      : snap.running ? (snap.running.label || 'WORKING').toUpperCase()
        : `${total} QUEUED`;
  if (jobsPanelOpen) renderJobsPanel(snap);
}

function renderJobsPanel(snap) {
  const el = document.getElementById('jobs-panel');
  if (!el) return;
  const review = reviewPending();
  const row = (j, done) => `
    <div class="jp-row ${done ? 'done ' + j.state : j.state}">
      <span class="jp-dot"></span>
      <span class="jp-label">${esc(j.label || j.type)}</span>
      <span class="jp-meta">${done
    ? (j.state === 'failed' ? esc((j.error || 'failed').slice(0, 60)) : `${j.ms}ms`)
    : (j.state === 'running' ? 'running' : j.attempts ? `retry ${j.attempts}` : 'queued')}</span>
    </div>`;

  el.innerHTML = `
    <div class="jp-head">
      <b>Background activity</b>
      <button class="jp-x" data-action="jobs-close" aria-label="Close">&times;</button>
    </div>
    ${review.length ? `
    <div class="jp-sec">
      <h4>Needs your say <span>${review.length} folder${review.length === 1 ? '' : 's'}</span></h4>
      <p class="jp-hint">These didn't match anything confidently enough to add on their own.</p>
      ${review.slice(0, 8).map((r) => `
        <div class="jp-rev">
          <div class="jp-rev-top">
            <b>${esc(r.name)}</b>
            <span>${r.episodes} file${r.episodes === 1 ? '' : 's'}</span>
            <button class="jp-ign" data-action="review-ignore" data-folder="${esc(r.folder)}">Ignore</button>
          </div>
          ${r.candidates.length ? `<div class="jp-cands">${r.candidates.slice(0, 4).map((c) => `
            <button class="jp-cand" data-action="review-pick"
                    data-folder="${esc(r.folder)}" data-id="${c.id}">
              ${c.cover ? `<img src="${esc(c.cover)}" alt="" loading="lazy">` : '<span class="jp-nocov"></span>'}
              <span class="jp-cand-t">${esc(c.title)}</span>
              <span class="jp-cand-m">${c.year || 'TBA'}${c.format ? ' · ' + esc(fmtFormat(c.format)) : ''} · ${Math.round(c.score * 100)}%</span>
            </button>`).join('')}</div>`
    : '<p class="jp-hint">No likely match found — search for it by hand.</p>'}
        </div>`).join('')}
    </div>` : ''}
    <div class="jp-sec">
      <h4>Queue <span>${snap.pending} pending</span>
        ${snap.failed ? `<button class="jp-retry" data-action="jobs-retry">Retry failed</button>` : ''}</h4>
      ${snap.running ? row(snap.running) : ''}
      ${snap.queue.filter((j) => j.state !== 'running').slice(0, 10).map((j) => row(j)).join('')
    || (snap.running ? '' : '<p class="jp-hint">Nothing waiting.</p>')}
    </div>
    ${snap.history.length ? `
    <div class="jp-sec">
      <h4>Recently finished</h4>
      ${snap.history.slice(0, 8).map((j) => row(j, true)).join('')}
    </div>` : ''}`;
}

function toggleJobsPanel(force) {
  jobsPanelOpen = force ?? !jobsPanelOpen;
  let el = document.getElementById('jobs-panel');
  if (!jobsPanelOpen) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'jobs-panel';
    document.body.appendChild(el);
  }
  renderJobsPanel(window.hikariJobs.snapshot());
}

/* pick a candidate: add the show, then hand it the folder we already scanned */
async function reviewPick(folder, mediaId) {
  const entry = loadReview().find((r) => String(r.folder).toLowerCase() === String(folder).toLowerCase());
  reviewResolve(folder, 'added');
  toggleJobsPanel(true);
  try {
    const rec = await addByIdFast(mediaId);
    const scan = await window.hikari.mediaScanShow(folder);
    if (rec && scan) {
      applyShowScanMerge(rec, [{ folder, name: entry?.name || '', buckets: scan }]);
      persist();
    }
    toast(`Added “${rec.title}” and linked ${entry?.episodes || 0} file${entry?.episodes === 1 ? '' : 's'}`);
    if (shelfScreen.classList.contains('active')) renderShelf();
  } catch (err) {
    reviewResolve(folder, 'pending');
    toast(`Could not add — ${err.message}`, 'err');
  }
  toggleJobsPanel(true);
}


async function autoScanTick(force = false) {
  if (appSettings.autoScan === false || autoScanning) return;
  const roots = (appSettings.mediaRoots || []).filter(Boolean);
  if (!roots.length) return;
  if (!force && Date.now() - autoScanAt < AUTOSCAN_MIN_GAP) return;
  /* never race the manual importer over the same folders */
  if (impJob && ['discover', 'ready', 'run'].includes(impJob.phase)) return;
  autoScanning = true;
  autoScanAt = Date.now();
  try {
    const res = await window.hikari.mediaScan(roots);
    const already = linkedDirSet();
    const scanned = [];
    for (const r of res) {
      for (const s of r.shows || []) {
        if (!s.folder || !(s.buckets || []).some((b) => b.files.length)) continue;
        scanned.push({ ...s, isNew: !already.has(String(s.folder).toLowerCase()) });
      }
    }
    if (!scanned.length) return;

    /* Group by matched show FIRST, then apply once per show with every folder
       it owns — a show split across season folders must not be linked twice.
       Note this deliberately does NOT gate on the show folder being new: a new
       season usually appears as a subfolder INSIDE a folder that's already
       linked, so folder-level newness misses it entirely. The merge itself
       decides — it returns 0 and touches nothing when there's nothing to add. */
    const groups = groupEntries(library);
    const byShow = new Map();
    let unmatched = 0;
    for (const s of scanned) {
      const hit = matchShowFolder(s.name, groups);
      if (!hit) {
        if (s.isNew) unmatched++;
        /* identify it against AniList rather than leaving it in a toast —
           one job per folder so a slow search never stalls the scan */
        if (!reviewKnows(s.folder)) {
          window.hikariJobs.add('identify', { folder: s.folder, name: s.name, buckets: s.buckets }, {
            key: `identify:${String(s.folder).toLowerCase()}`,
            priority: 'idle',
            label: `Identifying · ${s.name}`
          });
        }
        continue;
      }
      const id = hit.group.rep.id;
      if (!byShow.has(id)) byShow.set(id, { root: hit.group.rep, folders: [] });
      byShow.get(id).folders.push(s);
    }

    let shows = 0, eps = 0;
    for (const { root, folders } of byShow.values()) {
      const out = applyShowScanMerge(root, folders);
      if (out.added > 0) { shows++; eps += out.added; }
    }
    if (shows) {
      persist();
      toast(`Auto-linked ${eps} episode${eps === 1 ? '' : 's'} across ${shows} show${shows === 1 ? '' : 's'}`);
      if (detailScreen.classList.contains('active')) renderDetail();
      else if (shelfScreen.classList.contains('active')) renderShelf();
    }
    if (unmatched && !autoScanNotified) {
      autoScanNotified = true;
      toast(`Identifying ${unmatched} new folder${unmatched === 1 ? '' : 's'}…`);
    }
  } catch (e) {
    console.warn('[autoscan]', e.message || e);
  } finally {
    autoScanning = false;
  }
}

/* ——— full-screen import (Plex-style): discover → confirm → per-show pipeline ——— */
const importScreen = $('#importScreen');
let impJob = null; // {phase:'discover'|'ready'|'run'|'done', rows, opts, done, total, currentTitle, cancelled}

function impRowHTML(r, i) {
  const cover = r.media?.coverImage?.large || (r.group ? (r.group.rep.artCover || r.group.rep.cover) : '');
  const CHIPS = {
    matching: '<span class="imp-chip wait">MATCHING…</span>',
    resolving: '<span class="imp-chip wait">CHECKING ANILIST…</span>',
    matched: '<span class="imp-chip ok">ON SHELF · LINK</span>',
    add: '<span class="imp-chip add">NEW · ADD &amp; LINK</span>',
    unknown: '<span class="imp-chip no">NO MATCH</span>',
    merged: '<span class="imp-chip wait">MERGED ↑</span>',
    error: '<span class="imp-chip no">ERROR</span>'
  };
  const steps = r.steps ? `
    <span class="imp-steps">${['link', 'details', 'rename', 'art'].map((k) =>
      `<i class="${r.steps[k] === true ? 'done' : r.steps[k] === 'run' ? 'run' : ''}">${k.toUpperCase()}</i>`).join('')}</span>` : '';
  return `
  <div class="imp-row ${r.status} ${r.checked ? 'on' : ''}" data-action="import-row-toggle" data-i="${i}"
    style="animation-delay:${Math.min(i, 20) * 30}ms">
    <span class="imp-check">${icon('check')}</span>
    <span class="imp-cover">${cover ? `<img src="${esc(cover)}" loading="lazy">` : ''}</span>
    <span class="imp-info">
      <b>${esc(r.title || r.folderName)}</b>
      <small>${esc(r.folderName)} · ${r.fileCount} FILE${r.fileCount === 1 ? '' : 'S'}${r.eps ? ` · ${r.eps} LINKED` : ''}${r.review?.length ? ` · ${r.review.length} SKIPPED` : ''}${r.error ? ` · ${esc(String(r.error).toUpperCase())}` : ''}</small>
    </span>
    ${steps || CHIPS[r.status] || ''}
  </div>`;
}
function impRender() {
  if (!impJob) return;
  $('#impList').innerHTML = impJob.rows.map(impRowHTML).join('');
  impFootRender();
}
function impUpdateRow(i) {
  const el = $(`.imp-row[data-i="${i}"]`);
  if (el && impJob) el.outerHTML = impRowHTML(impJob.rows[i], i);
}
function impStatus(t) { $('#impStatus').textContent = t; }
function impFootRender() {
  const j = impJob;
  const foot = $('#impFoot');
  if (!j) { foot.innerHTML = ''; return; }
  if (j.phase === 'run') {
    foot.innerHTML = `
      <div class="imp-bar"><i style="width:${Math.round((j.done / Math.max(1, j.total)) * 100)}%"></i></div>
      <span class="imp-count">${j.done}/${j.total}</span>`;
    return;
  }
  if (j.phase === 'done') {
    foot.innerHTML = `<span class="grow"></span><button class="btn-primary" data-action="import-close">Done</button>`;
    return;
  }
  if (j.phase !== 'ready') { foot.innerHTML = ''; return; }
  const link = j.rows.filter((r) => r.checked && r.status === 'matched').length;
  const add = j.rows.filter((r) => r.checked && r.status === 'add').length;
  foot.innerHTML = `
    <label class="chk-row" style="margin:0"><input type="checkbox" id="impOrganize" ${j.opts.organize ? 'checked' : ''}>
      Rename &amp; sort files — <b>Show - SxxEyy - Title</b></label>
    <span class="grow"></span>
    <span class="imp-count">${link} LINK · ${add} ADD</span>
    <button class="btn-primary" data-action="import-start" ${link + add ? '' : 'disabled'}>Start import</button>`;
}
function openImportScreen() {
  importScreen.hidden = false;
  requestAnimationFrame(() => importScreen.classList.add('on'));
  impPillSync();
}
function closeImportScreen() {
  importScreen.classList.remove('on');
  setTimeout(() => { importScreen.hidden = true; impPillSync(); }, 180);
  if (impJob && impJob.phase !== 'run' && impJob.phase !== 'done') impJob.cancelled = true;
}
function impPillSync() {
  const seg = $('#sb-import');
  const running = impJob && impJob.phase === 'run';
  seg.hidden = !(running && importScreen.hidden);
  if (running) {
    $('#sb-import-txt').textContent =
      `Importing ${impJob.done + 1}/${impJob.total}${impJob.currentTitle ? ` — ${impJob.currentTitle}` : ''}`;
  }
}

async function runMediaScan() {
  const roots = appSettings.mediaRoots || [];
  if (!roots.length) { toast('Add a library folder first', 'err'); return; }
  if (impJob && impJob.phase === 'run') { closeSettings(); openImportScreen(); return; }
  closeSettings();
  impJob = { phase: 'discover', rows: [], opts: { organize: true }, done: 0, total: 0, currentTitle: '' };
  openImportScreen();
  impStatus('SCANNING FOLDERS…');
  $('#impList').innerHTML = '';
  impFootRender();

  const res = await window.hikari.mediaScan(roots);
  if (impJob?.cancelled) return;
  const offline = res.filter((r) => r.error);
  const byName = new Map();
  for (const r of res) {
    for (const s of r.shows || []) {
      const k = normTitle(s.name);
      if (!byName.has(k)) byName.set(k, { folderName: s.name, folders: [], fileCount: 0 });
      const row = byName.get(k);
      row.folders.push(s);
      row.fileCount += s.buckets.reduce((a, b) => a + b.files.length, 0);
    }
  }
  impJob.rows = [...byName.values()]
    .sort((a, b) => a.folderName.localeCompare(b.folderName))
    .map((r) => ({ ...r, status: 'matching', checked: true, title: '', eps: 0, review: [] }));
  impStatus(`FOUND ${impJob.rows.length} SHOW FOLDERS${offline.length ? ` · ${offline.length} FOLDER OFFLINE` : ''}`);
  impRender();

  const groups = groupEntries(library);
  for (let i = 0; i < impJob.rows.length; i++) {
    if (impJob?.cancelled) return;
    const row = impJob.rows[i];
    const hit = matchShowFolder(row.folderName, groups);
    if (hit) { row.status = 'matched'; row.group = hit.group; row.title = hit.group.rep.title; }
    else row.status = 'resolving';
    impUpdateRow(i);
    if (i % 6 === 5) await new Promise((r2) => requestAnimationFrame(r2));
  }
  const pending = impJob.rows.filter((r) => r.status === 'resolving');
  for (let k = 0; k < pending.length; k++) {
    if (impJob?.cancelled) return;
    const row = pending[k];
    impStatus(`RESOLVING UNMATCHED FOLDERS ON ANILIST — ${k + 1}/${pending.length}`);
    try {
      const results = await searchAnime(row.folderName);
      const media = results.find((m) => ytSimilar(row.folderName, m) >= 0.72) || null;
      if (media) {
        const g = groups.find((gr) => gr.members.some((mm) => franchiseIds(mm).has(media.id)));
        if (g) { row.status = 'matched'; row.group = g; row.title = g.rep.title; }
        else { row.status = 'add'; row.media = media; row.title = media.title.english || media.title.romaji; }
      } else { row.status = 'unknown'; row.checked = false; }
    } catch { row.status = 'unknown'; row.checked = false; }
    impUpdateRow(impJob.rows.indexOf(row));
  }
  if (impJob?.cancelled) return;
  impJob.phase = 'ready';
  impStatus('READY — UNTICK ANYTHING YOU DON’T WANT, THEN START');
  impFootRender();
}

async function startImport() {
  const j = impJob;
  if (!j || j.phase !== 'ready') return;
  j.opts.organize = $('#impOrganize')?.checked ?? true;

  /* two folders can resolve to the same show — merge them into one job */
  const seen = new Map();
  for (const row of j.rows) {
    if (!row.checked || !['matched', 'add'].includes(row.status)) continue;
    const key = row.status === 'add' ? `m${row.media.id}` : `g${row.group.rep.id}`;
    if (seen.has(key)) {
      seen.get(key).folders.push(...row.folders);
      seen.get(key).fileCount += row.fileCount;
      row.status = 'merged'; row.checked = false; row.steps = null;
    } else {
      seen.set(key, row);
    }
  }
  const targets = [...seen.values()];
  j.phase = 'run';
  j.total = targets.length;
  j.done = 0;
  targets.forEach((r) => { r.steps = { link: false, details: false, rename: false, art: false }; });
  impStatus('IMPORTING…');
  impRender();
  impPillSync();

  for (const row of targets) {
    const i = j.rows.indexOf(row);
    j.currentTitle = row.title || row.folderName;
    impPillSync();
    try {
      /* LINK — add to shelf if new, then map files to episodes */
      row.steps.link = 'run'; impUpdateRow(i);
      const root = row.status === 'add' ? await addByIdFast(row.media.id) : row.group.rep;
      if (!root.franchise) {
        try { root.franchise = await fetchFranchise(root.id); root.frv = FRV_RELATIONS; } catch { /* map vs root only */ }
      }
      const out = applyShowScan(root, row.folders);
      row.eps = out.eps; row.review = out.review;
      row.steps.link = true;

      /* DETAILS — full episode merge so renames carry real titles */
      row.steps.details = 'run'; impUpdateRow(i);
      if ((root.epv || 0) < 4) { try { await mergeEpisodesInto(root); } catch { /* lazy upgrade later */ } }
      row.steps.details = true;

      /* RENAME — FileBot pass, only if opted in */
      row.steps.rename = 'run'; impUpdateRow(i);
      if (j.opts.organize) {
        const plan = buildOrganizePlan(root);
        if (plan.length) applyOrganizeResults(await window.hikari.mediaOrganize(plan));
      }
      row.steps.rename = true;

      /* ART — original-res pool for hero/billboard */
      row.steps.art = 'run'; impUpdateRow(i);
      try { await fetchPoolInto(root); } catch { /* picker can sweep later */ }
      row.steps.art = true;
      persist();
    } catch (err) {
      row.status = 'error';
      row.error = err.message;
      row.steps = null;
    }
    j.done++;
    impUpdateRow(i);
    impFootRender();
    impPillSync();
  }
  j.phase = 'done';
  j.currentTitle = '';
  impStatus(`IMPORT COMPLETE — ${j.done} SHOW${j.done === 1 ? '' : 'S'} PROCESSED`);
  impFootRender();
  impPillSync();
  toast(`Import complete — ${j.done} show${j.done === 1 ? '' : 's'} ✓`);
  if (shelfScreen.classList.contains('active')) renderShelf();
  if (detailScreen.classList.contains('active')) renderDetail();
}


async function linkLocalFolder(rootId) {
  const root = library.find((x) => x.id === rootId);
  if (!root) return;
  const dir = await window.hikari.mediaPickFolder();
  if (!dir) return;
  const scan = await window.hikari.mediaScanShow(dir);
  if (!scan || !scan.buckets.length) { toast('No video files found in that folder', 'err'); return; }
  const out = applyShowScan(root, [scan]);
  persist();
  toast(`Linked ${out.eps} local episode${out.eps === 1 ? '' : 's'}${out.review.length ? ` — ${out.review.length} skipped` : ''}`);
  if (detailId === rootId && detailScreen.classList.contains('active')) renderDetail();
}

/* ——— organizer: FileBot-style rename/sort, preview-then-apply ——— */
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '').trim().slice(0, 120);
}

function buildOrganizePlan(root) {
  const plan = [];
  const local = root.local;
  if (!local?.map) return plan;
  const seasons = orderedSeasons(root);
  const fr = root.franchise || [];
  const extras = fr.filter((x) => !isSeasonEntry(x) && x.format !== 'MOVIE');
  const movies = fr.filter((x) => !isSeasonEntry(x) && x.format === 'MOVIE');
  const showName = safeName(root.title);
  const dirs = local.dirs || [];
  const dirFor = (p) => {
    const low = p.toLowerCase();
    return dirs.find((d) => low.startsWith(d.toLowerCase() + '\\') || low.startsWith(d.toLowerCase() + '/')) || null;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const seen = new Set();

  for (const [mid, eps] of Object.entries(local.map)) {
    const mediaId = +mid;
    const sIdx = seasons.findIndex((x) => x.id === mediaId);
    const mv = movies.find((x) => x.id === mediaId);
    const exIdx = extras.findIndex((x) => x.id === mediaId);
    const rec = mediaId === root.id ? root : peekCache.get(mediaId);
    for (const [epStr, paths] of Object.entries(eps)) {
      const ep = +epStr;
      for (const p of paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        const showDir = dirFor(p);
        const ext = p.slice(p.lastIndexOf('.'));
        let to = null;
        if (sIdx >= 0 && showDir) {
          const epTitle = (rec?.episodesList || []).find((e) => e.number === ep)?.title;
          to = `${showDir}\\Season ${sIdx + 1}\\${showName} - S${pad(sIdx + 1)}E${pad(ep)}${epTitle ? ` - ${safeName(epTitle)}` : ''}${ext}`;
        } else if (mv) {
          const dir = p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')));
          to = `${dir}\\${safeName(mv.title)}${mv.year ? ` (${mv.year})` : ''}${ext}`;
        } else if (exIdx >= 0 && showDir) {
          to = `${showDir}\\Season 0\\${showName} - S00E${pad(exIdx + 1)} - ${safeName(extras[exIdx].title)}${ext}`;
        }
        if (to && to !== p) plan.push({ from: p, to, rootId: root.id });
      }
    }
  }
  return plan;
}

let orgPlan = [];
function openOrganize(rootIds) {
  const targets = rootIds
    .map((id) => library.find((x) => x.id === id))
    .filter((r) => r?.local?.map);
  orgPlan = targets.flatMap(buildOrganizePlan);
  scanModal.hidden = false;
  requestAnimationFrame(() => scanModal.classList.add('on'));
  if (!orgPlan.length) {
    scanPhase(`<p class="yt-status">Everything is already named and sorted correctly ✓</p>
      <div class="art-foot"><span></span><div class="art-foot-btns">
        <button class="btn-ghost" data-action="close-scan">Done</button></div></div>`);
    return;
  }
  const tail = (p) => p.split(/[\\/]/).slice(-2).join('\\');
  scanPhase(`
    <p class="yt-sub"><b>${orgPlan.length}</b> file${orgPlan.length === 1 ? '' : 's'} will be renamed into
    <b>Show - SxxEyy - Title</b> under <b>Season N</b> folders. Nothing moves until you apply.</p>
    <div class="yt-list yt-review org-list">
      ${orgPlan.slice(0, 250).map((op) => `
      <div class="yt-row plain"><span class="yt-info">
        <span class="yt-hits">${esc(tail(op.from))}</span>
        <span class="yt-title org-to">→ ${esc(tail(op.to))}</span>
      </span></div>`).join('')}
      ${orgPlan.length > 250 ? `<p class="yt-sub">…and ${orgPlan.length - 250} more.</p>` : ''}
    </div>
    <div class="art-foot">
      <span class="art-count">${orgPlan.length} CHANGES</span>
      <div class="art-foot-btns">
        <button class="btn-ghost" data-action="close-scan">Cancel</button>
        <button class="btn-primary" data-action="org-apply">Rename ${orgPlan.length} file${orgPlan.length === 1 ? '' : 's'}</button>
      </div>
    </div>`);
}

function applyOrganizeResults(res) {
  let moved = 0;
  for (const r of res) {
    if (!r.ok || r.skipped) continue;
    moved++;
    const root = library.find((x) => x.id === r.rootId);
    if (!root?.local?.map) continue;
    for (const eps of Object.values(root.local.map)) {
      for (const arr of Object.values(eps)) {
        const i = arr.indexOf(r.from);
        if (i >= 0) arr[i] = r.to;
      }
    }
  }
  return moved;
}

async function applyOrganize() {
  scanPhase(`<p class="yt-status"><span class="spinner"></span> Renaming ${orgPlan.length} files…</p>`);
  const res = await window.hikari.mediaOrganize(orgPlan);
  const moved = applyOrganizeResults(res);
  persist();
  const fails = res.filter((r) => !r.ok);
  scanPhase(`
    <p class="yt-status">Renamed <b>${moved}</b> file${moved === 1 ? '' : 's'} ✓${fails.length ? ` — ${fails.length} failed:` : ''}</p>
    ${fails.length ? `<div class="yt-list yt-review">${fails.slice(0, 20).map((f) => `
      <div class="yt-row plain"><span class="yt-info">
        <span class="yt-title">${esc(f.from.split(/[\\/]/).pop())}</span>
        <span class="yt-hits">${esc(f.error || '')}</span>
      </span></div>`).join('')}</div>` : ''}
    <div class="art-foot"><span></span><div class="art-foot-btns">
      <button class="btn-ghost" data-action="close-scan">Done</button></div></div>`);
  if (detailScreen.classList.contains('active')) renderDetail();
}

/* ——— settings: roots list ——— */
function renderMediaRoots() {
  const roots = appSettings.mediaRoots || [];
  $('#mediaRoots').innerHTML = roots.length ? roots.map((r, i) => `
    <div class="mroot">
      <span class="mroot-path" title="${esc(r)}">${esc(r)}</span>
      <button class="mroot-btn" data-action="media-root-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="mroot-btn" data-action="media-root-down" data-idx="${i}" ${i === roots.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="mroot-btn del" data-action="media-root-del" data-idx="${i}">×</button>
    </div>`).join('')
    : '<p class="no-eps" style="padding:4px 0 10px">No folders linked yet.</p>';
}

/* ——— player ——— */
const playerModal = $('#playerModal');
const plVideo = $('#plVideo');
let plCtx = null; // {root, mediaId, ep, files, epKey, marked}

window.hikari.onMediaProgress(({ epKey, pct, kind, done, error }) => {
  /* background queue progress rides the same channel */
  if (epKey.startsWith('bg:')) {
    if (convCurrentKey === epKey && pct >= 0) convPillSync(pct);
    return;
  }
  if (!plCtx || epKey !== plCtx.epKey) return;
  if (error) { toast(`Conversion hit a wall — ${error}`, 'err'); return; }
  const waiting = $('.player-shell').classList.contains('waiting');
  if (waiting) {
    const t = $('#plWaitText');
    if (t) t.textContent = `${kind === 'transcode' ? 'CONVERTING' : 'PREPARING'} — ${pct}%`;
    const bar = $('#plBar');
    if (bar) bar.style.width = `${pct}%`;
    const note = $('#plNote');
    if (note) {
      /* both paths stream now — a remux just doesn't re-encode anything */
      note.textContent = kind === 'transcode'
        ? 'STARTS PLAYING IN A FEW SECONDS — CONVERTS THE REST WHILE YOU WATCH'
        : 'STARTS PLAYING IN A MOMENT — VIDEO QUALITY UNTOUCHED';
    }
  } else {
    const chip = $('#plConv');
    if (!chip) return;
    if (done) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.textContent = `${kind === 'remux' ? 'REPACKAGING' : 'CONVERTING'} AHEAD — ${pct}%`;
  }
});

function posKey(mediaId, ep) { return `${mediaId}:${ep}`; }

async function playLocal(mediaId, ep) {
  const root = library.find((x) => x.id === detailId) || library.find((x) => x.local?.map?.[mediaId]);
  if (!root) return;
  const files = root.local?.map?.[mediaId]?.[ep] || [];
  if (!files.length) { toast('No local file for this episode', 'err'); return; }

  if (plCtx) window.hikari.mediaCancel(plCtx.epKey);
  /* playback owns the CPU — pause the background queue and bump its job */
  if (convBusy && !convPaused) {
    convPaused = true;
    if (convCurrentKey) window.hikari.mediaCancel(convCurrentKey);
    convPillSync();
  }
  plCtx = { root, mediaId, ep, files, epKey: `${mediaId}:${ep}`, marked: false, file: files[0] };

  const rec = peekCache.get(mediaId) || root;
  $('#plTitle').textContent = rec.title || root.title;
  const row = (rec.episodesList || []).find((e) => e.number === ep);
  $('#plSub').textContent = `E${ep}${row?.title ? ` · ${row.title}` : ''}`;
  $('#plCc').hidden = true;
  $('#plNext').hidden = true;
  $('#plWait').hidden = false;
  $('#plWaitText').textContent = 'PREPARING…';
  $('#plBar').style.width = '0%';
  $('#plNote').textContent = '';
  $('.player-shell').classList.add('waiting');
  plVideo.removeAttribute('src');
  plVideo.innerHTML = '';
  playerModal.hidden = false;
  requestAnimationFrame(() => playerModal.classList.add('on'));

  let lastErr = 'No playable source';
  for (const file of files) {
    plCtx.file = file;
    const res = await window.hikari.mediaPrepare(file, plCtx.epKey);
    if (!plCtx || plCtx.epKey !== `${mediaId}:${ep}`) return; // closed/superseded
    if (res.ok) { startPlayback(res); return; }
    if (res.cancelled) return;
    lastErr = res.error;
  }
  $('#plWait').hidden = false;
  $('#plWaitText').textContent = `COULD NOT PLAY — ${lastErr}`.toUpperCase();
}

let hlsInst = null;
function attachSource(res) {
  if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
  if (String(res.mode).startsWith('hls') && window.Hls && Hls.isSupported()) {
    hlsInst = new Hls({ maxBufferLength: 60, backBufferLength: 60, enableWorker: false });
    hlsInst.loadSource(res.url);
    hlsInst.attachMedia(plVideo);
  } else {
    plVideo.src = res.url;
  }
}

function startPlayback(res) {
  const { root, mediaId, ep } = plCtx;
  window.__PL_DEBUG = { mode: res.mode, audioLang: res.audioLang, ep };
  $('#plWait').hidden = true;
  $('.player-shell').classList.remove('waiting');
  $('#plConv').hidden = res.mode !== 'hls-live';
  if (res.mode === 'hls-live') $('#plConv').textContent = 'PREPARING AHEAD…';
  attachSource(res);
  if (res.subs?.length) {
    const tr = document.createElement('track');
    tr.kind = 'subtitles';
    tr.label = 'Subtitles';
    tr.src = res.subs[0];
    plVideo.appendChild(tr);
    $('#plCc').hidden = false;
    $('#plCc').classList.remove('on');
  }
  const saved = (root.playPos || {})[posKey(mediaId, ep)] || 0;
  const target = saved > 30 ? Math.max(0, saved - 8) : 0;
  plVideo.addEventListener('loadedmetadata', () => {
    if (target) plVideo.currentTime = target;
  }, { once: true });
  plVideo.play().catch(() => {});
}

let posSaveAt = 0;
plVideo.addEventListener('timeupdate', () => {
  if (!plCtx || !plVideo.duration) return;
  const now = Date.now();
  if (now - posSaveAt > 5000) {
    posSaveAt = now;
    (plCtx.root.playPos = plCtx.root.playPos || {})[posKey(plCtx.mediaId, plCtx.ep)] = Math.floor(plVideo.currentTime);
    persist();
  }
  if (!plCtx.marked && plVideo.currentTime / plVideo.duration >= 0.9) {
    plCtx.marked = true;
    setEpWatched(plCtx.root, plCtx.mediaId, plCtx.ep, true);
    if (detailScreen.classList.contains('active')) refreshWatchedUI(plCtx.root);
    toast('Marked watched ✓');
  }
  const remaining = plVideo.duration - plVideo.currentTime;
  const hasNext = !!localFileFor(plCtx.root, plCtx.mediaId, plCtx.ep + 1);
  $('#plNext').hidden = !(hasNext && remaining < 45);
});
plVideo.addEventListener('ended', () => {
  if (plCtx && localFileFor(plCtx.root, plCtx.mediaId, plCtx.ep + 1)) {
    const { mediaId, ep } = plCtx;
    playLocal(mediaId, ep + 1);
  }
});

function closePlayer() {
  if (plCtx) {
    window.hikari.mediaCancel(plCtx.epKey);
    if (plVideo.duration && plVideo.currentTime > 0) {
      (plCtx.root.playPos = plCtx.root.playPos || {})[posKey(plCtx.mediaId, plCtx.ep)] = Math.floor(plVideo.currentTime);
      persist();
    }
  }
  plCtx = null;
  if (hlsInst) { hlsInst.destroy(); hlsInst = null; }
  plVideo.pause();
  plVideo.removeAttribute('src');
  plVideo.innerHTML = '';
  plVideo.load();
  playerModal.classList.remove('on');
  setTimeout(() => { playerModal.hidden = true; }, 200);
  convPaused = false; // resume the background queue
}
playerModal.addEventListener('click', (e) => { if (e.target === playerModal) closePlayer(); });

/* ——— background pre-convert queue ——— */
let convQueue = [];
let convBusy = false;
let convPaused = false;
let convPlanning = false;
let convPlanN = 0;
let convPlanTotal = 0;
let convFineN = 0;
let convFailN = 0;
let convDone = 0;
let convTotal = 0;
let convCurrent = '';
let convCurrentKey = '';

function convPillSync(pct) {
  const seg = $('#sb-convert');
  const active = convBusy && (convPlanning || convQueue.length > 0);
  seg.hidden = !active;
  if (!active) return;
  seg.querySelector('.sb-spin').style.visibility = convPaused && !convPlanning ? 'hidden' : 'visible';
  if (convPlanning) {
    $('#sb-convert-txt').textContent = `Checking local library — ${convPlanN}/${convPlanTotal} files…`;
    seg.title = 'Working out which files need converting.';
    $('#sb-conv-bar').style.width = `${convPlanTotal ? Math.round((convPlanN / convPlanTotal) * 100) : 0}%`;
    return;
  }
  const shows = new Set(convQueue.map((i) => i.title)).size;
  $('#sb-convert-txt').textContent = convPaused
    ? `Converting paused — ${convDone}/${convTotal} done · ${convQueue.length} file${convQueue.length === 1 ? '' : 's'} across ${shows} show${shows === 1 ? '' : 's'} left · click to resume`
    : `Converting ${convDone + 1}/${convTotal} — ${convCurrent}`;
  /* hover: plan summary + the actual up-next list */
  seg.title = `Planned: ${convTotal} to convert · ${convFineN} already playable${convFailN ? ` · ${convFailN} UNREACHABLE` : ''}\n`
    + 'Up next:\n' + convQueue.slice(0, 8)
      .map((i) => `· ${i.title} — ${i.path.split(/[\\/]/).pop()}`).join('\n')
    + (convQueue.length > 8 ? `\n…and ${convQueue.length - 8} more` : '');
  $('#sb-conv-bar').style.width = pct != null ? `${pct}%`
    : `${convTotal ? Math.round((convDone / convTotal) * 100) : 0}%`;
}


/* every folder the app knows about — Settings roots PLUS each show's linked
   dirs. Linked-folder roots used to evaporate on restart (main only whitelists
   them at pick time), leaving whole libraries unreachable and silently skipped. */
function syncMediaRoots() {
  const dirs = new Set((appSettings.mediaRoots || []).filter(Boolean));
  for (const r of library) for (const d of r.local?.dirs || []) if (d) dirs.add(d);
  return window.hikari.mediaSetRoots([...dirs]).catch(() => {});
}

/* every local file belonging to ONE show, newest-linked order */
function localFilesForRoot(root) {
  const seen = new Set();
  const out = [];
  for (const eps of Object.values(root.local?.map || {})) {
    for (const arr of Object.values(eps)) {
      for (const p of arr) {
        if (!seen.has(p)) { seen.add(p); out.push({ path: p, title: root.title }); }
      }
    }
  }
  return out;
}

let convAbort = false;
async function startConvertQueue(root) {
  if (!root?.local?.map) { toast('No local files linked for this show'); return; }
  if (convBusy) {
    toast(`Already converting ${convQueue[0]?.title || 'another show'} — one show at a time`);
    return;
  }
  convBusy = true;
  convAbort = false;
  try {
    await syncMediaRoots(); // linked-but-not-in-Settings libraries count too
    const files = localFilesForRoot(root);
    convPlanning = true;
    convPlanN = 0; convPlanTotal = files.length; convFineN = 0; convFailN = 0;
    convPillSync();
    const todo = [];
    for (const f of files) {
      if (convAbort) break;
      convPlanN++;
      const n = await window.hikari.mediaNeeds(f.path);
      if (!n.ok) convFailN++;
      else if (n.action !== 'direct' && !n.cached) todo.push(f);
      else convFineN++;
      if (convPlanN % 8 === 0) convPillSync();
    }
    convPlanning = false;
    convQueue = todo;
    convTotal = todo.length;
    convDone = 0;
    if (convFailN) {
      toast(`${convFailN} local file${convFailN === 1 ? '' : 's'} unreachable — drive offline or folder missing?`, 'err');
    }
    if (!convTotal) {
      convPillSync();
      if (!convFailN) toast(`${root.title} — every episode already plays instantly ✓`);
      return;
    }
    convPillSync();
    while (convQueue.length && !convAbort) {
      if (convPaused) { await new Promise((r) => setTimeout(r, 1500)); convPillSync(); continue; }
      const item = convQueue[0];
      convCurrent = `${item.title} · ${item.path.split(/[\\/]/).pop()}`;
      convCurrentKey = `bg:${item.path}`;
      convPillSync();
      const res = await window.hikari.mediaPrepare(item.path, convCurrentKey, true);
      if (res?.cancelled) continue; // paused or interrupted — never count it done, retry later
      convQueue.shift();
      convDone++;
      convPillSync();
    }
    if (convDone && !convQueue.length) toast(`${root.title} — ${convDone} file${convDone === 1 ? '' : 's'} converted, instant playback ready ✓`);
  } finally {
    convBusy = false;
    convCurrent = '';
    convCurrentKey = '';
    convPillSync();
  }
}

/* ———————————————————— nav rail ———————————————————— */
$$('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentView = btn.dataset.view;
    $$('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
    filterText = '';
    renderShelf();
    showScreen('shelf');
  });
});

/* ———————————————————— window controls ———————————————————— */
$('#win-min').addEventListener('click', () => window.hikari.winMinimize());
$('#win-max').addEventListener('click', () => window.hikari.winMaximize());
$('#win-close').addEventListener('click', () => window.hikari.winClose());

/* hovering a season tab starts its fetch early — by the time you click,
   it's usually already cached and the switch is instant */
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-action="view-related"]');
  if (!el) return;
  const id = +el.dataset.id;
  if (id && !peekCache.has(id)) fetchPeek(id).catch(() => {});
});

/* ———————————————————— global actions ———————————————————— */
document.addEventListener('click', async (e) => {
  /* close any open menu when clicking elsewhere */
  if ($('.cmenu') && !e.target.closest('.cmenu') &&
      !e.target.closest('[data-action="card-menu"]') && !e.target.closest('[data-action="hero-menu"]') &&
      !e.target.closest('[data-action="ep-menu"]')) {
    closeCardMenu();
  }
  /* filter dropdowns close on outside click — via the state variable, so a
     later re-render agrees with what's on screen */
  if (openDd) {
    const sec = { genreDd: '.sec-genres', tagDd: '.sec-tags', srcDd: '.sec-sources', sortDd: '.sec-sort' }[openDd];
    if (sec && !e.target.closest(`${sec} .gsel`)) {
      openDd = null;
      syncDropdowns();
    }
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'menu-noop': break;

    case 'card-menu': openCardMenu(el); break;
    case 'open-family': openFamily(el.closest('.anime-card'), +el.dataset.id); break;
    case 'bb-step': bbShow(bbIndex + (+el.dataset.dir)); break;
    case 'bb-go': bbShow(+el.dataset.i); break;
    case 'open-announce': {
      const id = +el.dataset.id;
      const owner = library.find((x) => x.id === id) || library.find((x) => franchiseIds(x).has(id));
      if (owner) { goDetail(owner.id); if (owner.id !== id) switchView(id).catch(() => {}); break; }
      el.classList.add('busy');
      el.querySelector('.ann-act').textContent = 'ADDING…';
      addByIdFast(id).then((rec) => { toast(`Added “${rec.title}”`); goDetail(rec.id); })
        .catch((err) => toast(err.message || 'Could not add that', 'err'));
      break;
    }
    case 'family-close': closeFamily(); break;
    case 'family-open': {
      const id = +el.dataset.id;
      const owner = library.find((x) => x.id === id) || library.find((x) => franchiseIds(x).has(id));
      closeFamily();
      if (owner) { goDetail(owner.id); if (owner.id !== id) switchView(id).catch(() => {}); }
      break;
    }
    case 'family-add': {
      const id = +el.dataset.id;
      el.classList.add('busy');
      el.querySelector('.fam-act').textContent = 'ADDING…';
      addByIdFast(id).then((rec) => {
        closeFamily();
        toast(`Added “${rec.title}”`);
        renderShelf();
      }).catch((err) => toast(err.message || 'Could not add that', 'err'));
      break;
    }
    case 'hero-menu': openHeroMenu(el); break;

    case 'toggle-fav': {
      const root = library.find((x) => x.id === detailId);
      if (!root) break;
      root.favourite = !root.favourite;
      persist();
      el.classList.toggle('on', root.favourite);
      el.innerHTML = icon(root.favourite ? 'heart-fill' : 'heart');
      el.title = root.favourite ? 'Unfavourite' : 'Add to favourites';
      toast(root.favourite ? 'Added to favourites ♥' : 'Removed from favourites');
      break;
    }
    case 'menu-fav': {
      const root = library.find((x) => x.id === +el.dataset.id);
      if (!root) break;
      root.favourite = !root.favourite;
      persist();
      closeCardMenu();
      if (currentView === 'favourites') renderShelf(); else refreshShelfGrid();
      toast(root.favourite ? 'Added to favourites ♥' : 'Removed from favourites');
      break;
    }
    case 'disc-details': {
      const id = Number(el.dataset.id);
      closeDiscPreview();
      goPreview(id);
      break;
    }
    case 'disc-add': {
      if (el.classList.contains('busy')) break;
      el.classList.add('busy');
      const addId = +el.dataset.id;
      if (el.classList.contains('disc-add')) el.textContent = 'ADDING…';
      else el.textContent = 'Adding…';
      try {
        const record = await addByIdFast(addId);
        discSeen.add(addId); // now on the shelf — out of the picks
        closeDiscPreview();
        goDetail(record.id);
        toast('Added to your shelf');
      } catch (err) {
        el.classList.remove('busy');
        el.textContent = el.classList.contains('disc-add') ? '+ ADD' : '+ Add to shelf';
        toast(`Could not add — ${err.message}`, 'err');
      }
      break;
    }
    case 'disc-view': openDiscPreview(+el.dataset.id); break;
    case 'disc-close': closeDiscPreview(); break;
    case 'disc-refresh': {
      /* rotate: everything currently visible becomes "seen"; when the pool
         runs dry, loop back to the top picks */
      for (const e of visibleDiscover()) discSeen.add(e.media.id);
      const freshLeft = discoverPool ? discoverPool.filter((e) => !discSeen.has(e.media.id)).length : 0;
      if (!freshLeft) { discSeen.clear(); toast('Back to the top picks'); }
      renderDiscover();
      break;
    }
    case 'disc-genre': {
      const g = el.dataset.genre;
      discGenre.has(g) ? discGenre.delete(g) : discGenre.add(g);
      renderDiscover();
      break;
    }
    case 'disc-genre-clear': discGenre.clear(); renderDiscover(); break;
    case 'open-trailer': openTrailer(el.dataset.yt); break;
    case 'close-trailer': closeTrailer(); break;
    case 'close-keys': closeKeys(); break;
    case 'open-identify': openIdentify(); break;
    case 'id-close': closeIdentify(); break;
    case 'id-pick': $('#idFile').click(); break;
    case 'id-clip': {
      if (!el.dataset.clip) break;
      $('#idClip')?.remove();
      document.body.insertAdjacentHTML('beforeend',
        `<div class="id-cliplay" id="idClip" data-action="id-clip-close">
           <video src="${esc(el.dataset.clip)}" autoplay loop playsinline controls></video>
         </div>`);
      break;
    }
    case 'id-clip-close': $('#idClip')?.remove(); break;
    case 'id-open': {
      const g = groupEntries(library).find((x) => x.members.some((m) => franchiseIds(m).has(+el.dataset.id)));
      if (g) { closeIdentify(); goDetail(g.rep.id); }
      break;
    }
    case 'id-add': {
      el.disabled = true;
      el.textContent = 'Adding…';
      try {
        const root = await addById(+el.dataset.id);
        toast(`${root.title} added`);
        closeIdentify();
        goDetail(root.id);
      } catch (err) {
        el.disabled = false; el.textContent = 'Add';
        toast(`Could not add — ${err.message || err}`, 'err');
      }
      break;
    }

    case 'play-local': playLocal(+el.dataset.media, +el.dataset.n); break;
    case 'close-player': closePlayer(); break;
    case 'pl-cc': {
      const track = plVideo.textTracks[0];
      if (!track) break;
      const on = track.mode !== 'showing';
      track.mode = on ? 'showing' : 'hidden';
      el.classList.toggle('on', on);
      break;
    }
    case 'pl-system': {
      if (plCtx?.file) window.hikari.mediaOpenExternal(plCtx.file);
      break;
    }
    case 'pl-next': {
      if (plCtx) playLocal(plCtx.mediaId, plCtx.ep + 1);
      break;
    }
    case 'preconvert-show': {
      closeCardMenu();
      const root = library.find((x) => x.id === detailId);
      if (root) startConvertQueue(root);
      break;
    }
    case 'convert-pill': {
      convPaused = !convPaused;
      /* pausing must KILL the in-flight ffmpeg job, not just flag the loop —
         otherwise the current file keeps converting for minutes "while paused" */
      if (convPaused && convBusy && convCurrentKey) window.hikari.mediaCancel(convCurrentKey);
      convPillSync();
      break;
    }
    case 'link-local': closeCardMenu(); linkLocalFolder(+el.dataset.id); break;
    case 'close-scan': closeScanModal(); break;
    case 'media-scan': runMediaScan(); break;
    case 'import-close': closeImportScreen(); break;
    case 'import-pill': openImportScreen(); break;
    case 'import-start': startImport(); break;
    case 'import-row-toggle': {
      if (!impJob || impJob.phase !== 'ready') break;
      const row = impJob.rows[+el.dataset.i];
      if (!row || !['matched', 'add'].includes(row.status)) break;
      row.checked = !row.checked;
      impUpdateRow(+el.dataset.i);
      impFootRender();
      break;
    }
    case 'dub-adj': {
      const rec = getViewRecord();
      if (!rec) break;
      const di = dubInfo(rec);
      if (!di) break;
      const next = Math.max(0, Math.min(di.aired || 999, di.upTo + +el.dataset.d));
      rec.dubOverride = { ep: next, at: Date.now() };
      persist();
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
      break;
    }
    case 'organize-local': closeCardMenu(); openOrganize([+el.dataset.id]); break;
    case 'org-all': openOrganize(library.filter((r) => r.local?.map).map((r) => r.id)); break;
    case 'org-apply': applyOrganize(); break;
    case 'media-add-root': {
      const dir = await window.hikari.mediaPickFolder();
      if (!dir) break;
      appSettings.mediaRoots = appSettings.mediaRoots || [];
      if (!appSettings.mediaRoots.includes(dir)) appSettings.mediaRoots.push(dir);
      window.hikari.saveSettings(appSettings).catch(() => {});
      window.hikari.mediaSetRoots(appSettings.mediaRoots);
      renderMediaRoots();
      break;
    }
    case 'media-root-del': {
      appSettings.mediaRoots.splice(+el.dataset.idx, 1);
      window.hikari.saveSettings(appSettings).catch(() => {});
      window.hikari.mediaSetRoots(appSettings.mediaRoots);
      renderMediaRoots();
      break;
    }
    case 'media-root-up':
    case 'media-root-down': {
      const i = +el.dataset.idx;
      const j = action === 'media-root-up' ? i - 1 : i + 1;
      const r = appSettings.mediaRoots;
      if (j < 0 || j >= r.length) break;
      [r[i], r[j]] = [r[j], r[i]];
      window.hikari.saveSettings(appSettings).catch(() => {});
      window.hikari.mediaSetRoots(r);
      renderMediaRoots();
      break;
    }

    case 'menu-watch-all': {
      const root = library.find((x) => x.id === +el.dataset.id);
      if (!root) break;
      markAllSeasons(root, el.dataset.watch === '1');
      closeCardMenu();
      renderShelf();
      toast(el.dataset.watch === '1' ? 'All seasons marked watched ✓' : 'Marked unwatched');
      break;
    }

    case 'menu-art': {
      closeCardMenu();
      openArtModal(+el.dataset.id);
      break;
    }

    case 'menu-remove': {
      const ids = (el.dataset.group || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) break;
      if (el.dataset.armed) {
        closeCardMenu();
        removeGroup(ids);
      } else {
        el.dataset.armed = '1';
        el.textContent = 'Remove — sure?';
        setTimeout(() => {
          if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Remove from shelf'; }
        }, 2600);
      }
      break;
    }

    case 'open-art-modal': closeCardMenu(); openArtModal(detailId); break;
    case 'close-art-modal': closeArtModal(); break;

    case 'preview-add': {
      const id = Number(el.dataset.id);
      el.classList.add('busy');
      el.textContent = 'Adding…';
      try {
        const rec = await addByIdFast(id);
        previewRec = null;              // it is a real record now
        detailId = rec.id;
        viewId = initialViewFor(rec.id);
        renderDetail();
        updateChrome();
        toast('Added "' + rec.title + '" to your shelf');
      } catch (err) {
        el.classList.remove('busy');
        toast('Could not add — ' + (err.message || err), 'err');
      }
      break;
    }
    case 'jobs-pill': toggleJobsPanel(); break;
    case 'jobs-close': toggleJobsPanel(false); break;
    case 'jobs-retry': window.hikariJobs.retryFailed(); break;
    case 'review-ignore':
      reviewResolve(el.dataset.folder, 'ignored');
      toggleJobsPanel(true);
      break;
    case 'review-pick':
      reviewPick(el.dataset.folder, Number(el.dataset.id));
      break;
    case 'open-settings': openSettings(); break;
    case 'close-settings': closeSettings(); break;
    case 'save-settings': saveSettingsModal(); break;
    case 'set-tab': switchSettingsTab(el.dataset.tab); break;
    case 'key-eye': {
      const inp = el.closest('.key-wrap').querySelector('input');
      inp.dataset.revealed = inp.dataset.revealed === '1' ? '' : '1';
      syncKeyMask(inp);
      break;
    }
    case 'export-data': exportLibrary(); break;
    case 'import-data': importLibrary(); break;
    case 'open-data-dir': window.hikari.openDataDir?.(); break;

    case 'remote-toggle': {
      const turnOn = !remoteState?.running;
      try {
        remoteState = await window.hikari.remoteSetEnabled(turnOn);
        /* main persists remoteEnabled itself, but saveSettings below REPLACES
           the whole file from the renderer's copy — so mirror the flag here or
           we immediately clobber what main just wrote. */
        appSettings.remoteEnabled = turnOn;
        /* the phone finds this machine through the synced settings row, so the
           address has to go with the server rather than linger after it stops */
        await publishRemote(remoteState);
        toast(turnOn ? 'Remote play on' : 'Remote play off — phone playback stops');
      } catch (err) {
        toast(`Could not change remote play — ${err.message || err}`, 'err');
      }
      fillRemoteBox();
      break;
    }
    case 'remote-rotate': {
      try {
        remoteState = await window.hikari.remoteRotateToken();
        await publishRemote(remoteState);
        toast('Token rotated — other devices reconnect on their next sync');
      } catch (err) {
        toast(`Could not rotate token — ${err.message || err}`, 'err');
      }
      fillRemoteBox();
      break;
    }


    case 'art-tab': {
      artKind = el.dataset.kind;
      artIdx = 0;
      const root = library.find((x) => x.id === artTargetId);
      if (root) renderArtRows(root);
      break;
    }
    case 'art-prev':
    case 'art-next': {
      const root = library.find((x) => x.id === artTargetId);
      if (!root) break;
      const { covers, banners } = artCandidates(root);
      const n = (artKind === 'cover' ? covers : banners).length;
      if (!n) break;
      artIdx = (artIdx + (action === 'art-next' ? 1 : -1) + n) % n;
      updateArtSelection(root, { scrollThumb: true });
      break;
    }
    case 'art-jump': {
      if (stripDragged) break; // it was a drag, not a pick
      artIdx = +el.dataset.i;
      const root = library.find((x) => x.id === artTargetId);
      if (root) updateArtSelection(root);
      break;
    }
    case 'art-apply': artApplyCurrent(); break;
    case 'open-search': openSearch(); break;
    case 'back': goShelf(); break;
    case 'open-show': {
      clearMorphNames();
      const cov = el.querySelector('.ac-cover');
      if (cov) cov.style.viewTransitionName = 'hero-poster';
      goDetail(+el.dataset.id);
      /* calendar/on-air tiles advertise a SPECIFIC season — land viewing it */
      const media = +el.dataset.media;
      if (media && media !== +el.dataset.id) switchView(media);
      break;
    }
    case 'open-url': closeCardMenu(); window.hikari.openExternal(el.dataset.url); break;

    case 'rail': {
      const scroll = el.parentElement.querySelector('.rail-scroll');
      if (scroll) {
        const amt = Math.round(scroll.clientWidth * 0.82);
        scroll.scrollBy({ left: el.dataset.dir === 'next' ? amt : -amt, behavior: 'smooth' });
      }
      break;
    }

    case 'set-sort':
      sortMode = el.dataset.sort;
      appSettings.sortMode = sortMode;
      window.hikari.saveSettings(appSettings).catch(() => {});
      renderShelf();
      break;

    case 'sort-dd': {
      openDd = openDd === 'sortDd' ? null : 'sortDd';
      syncDropdowns();
      break;
    }
    case 'genre-dd': {
      openDd = openDd === 'genreDd' ? null : 'genreDd';
      syncDropdowns();
      break;
    }
    case 'genre-opt': {
      const g = el.dataset.genre;
      genreFilter.has(g) ? genreFilter.delete(g) : genreFilter.add(g);
      $$(`.gopt[data-genre="${CSS.escape(g)}"]`, shelfScreen).forEach((o) => o.classList.toggle('on', genreFilter.has(g)));
      refreshShelfGrid();
      break;
    }
    case 'genre-clear': {
      genreFilter.clear();
      $$('.sec-genres .gopt.on', shelfScreen).forEach((o) => o.classList.remove('on'));
      refreshShelfGrid();
      break;
    }

    case 'tag-dd': {
      openDd = openDd === 'tagDd' ? null : 'tagDd';
      syncDropdowns();
      break;
    }
    case 'tag-opt': {
      const t = el.dataset.tag;
      tagFilter.has(t) ? tagFilter.delete(t) : tagFilter.add(t);
      $$(`.gopt[data-tag="${CSS.escape(t)}"]`, shelfScreen).forEach((o) => o.classList.toggle('on', tagFilter.has(t)));
      refreshShelfGrid();
      break;
    }
    case 'tag-clear': {
      tagFilter.clear();
      $$('.sec-tags .gopt.on', shelfScreen).forEach((o) => o.classList.remove('on'));
      refreshShelfGrid();
      break;
    }
    case 'tag-jump': {
      /* a tag chip on the detail page: filter the shelf by it */
      tagFilter.clear();
      tagFilter.add(el.dataset.tag);
      goShelf();
      break;
    }

    case 'src-dd': {
      openDd = openDd === 'srcDd' ? null : 'srcDd';
      syncDropdowns();
      break;
    }
    case 'src-opt': {
      const s = el.dataset.src;
      sourceFilter.has(s) ? sourceFilter.delete(s) : sourceFilter.add(s);
      $$(`.gopt[data-src="${CSS.escape(s)}"]`, shelfScreen).forEach((o) => o.classList.toggle('on', sourceFilter.has(s)));
      refreshShelfGrid();
      break;
    }
    case 'src-clear': {
      sourceFilter.clear();
      $$('.sec-sources .gopt.on', shelfScreen).forEach((o) => o.classList.remove('on'));
      refreshShelfGrid();
      break;
    }

    case 'open-source-modal': openSourceModal(detailId); break;
    case 'close-source-modal': closeSourceModal(); break;
    case 'save-source': saveSource(); break;

    case 'adopt-link': {
      const s = library.find((x) => x.id === detailId);
      if (!s) break;
      s.sources = s.sources || [];
      if (s.sources.some((src) => src.url === el.dataset.url)) { toast('Already in your sources'); break; }
      s.sources.push({ name: el.dataset.site, url: el.dataset.url });
      persist();
      renderDetail();
      toast(`${el.dataset.site} added as a source`);
      break;
    }

    case 'remove-source': {
      const s = library.find((x) => x.id === detailId);
      if (!s) break;
      s.sources.splice(+el.dataset.idx, 1);
      persist();
      renderDetail();
      break;
    }

    case 'toggle-desc': {
      const desc = $('#desc');
      const clamped = desc.classList.toggle('clamped');
      el.textContent = clamped ? 'READ MORE' : 'SHOW LESS';
      break;
    }

    case 'toggle-ep': {
      const root = library.find((x) => x.id === detailId);
      if (!root) break;
      const mediaId = +el.dataset.media, n = +el.dataset.n;
      const now = !epWatched(root, mediaId, n);
      setEpWatched(root, mediaId, n, now);
      const host = el.closest('.ep-card, .ep-row');
      host?.classList.toggle('seen', now);
      (host ? host.querySelector('.ep-check') : el).classList.toggle('on', now);
      if (el.closest('.ep-cmenu')) closeCardMenu();
      if (el.closest('#epBody')) el.textContent = now ? 'Unmark watched' : '✓ Mark watched';
      refreshWatchedUI(root);
      break;
    }

    case 'ep-menu': openEpMenu(el); break;
    case 'ep-info': closeCardMenu(); openEpInfo(+el.dataset.media, +el.dataset.n); break;
    case 'ep-close': closeEpInfo(); break;
    case 'ep-reveal': closeCardMenu(); window.hikari.revealFile?.(el.dataset.path); break;
    case 'ep-upto': {
      const root = library.find((x) => x.id === detailId);
      if (!root) break;
      const mediaId = +el.dataset.media, n = +el.dataset.n;
      const m = watchedMap(root);
      m[mediaId] = [...new Set([...(m[mediaId] || []), ...Array.from({ length: n }, (_, k) => k + 1)])].sort((a, b) => a - b);
      root.lastWatchedAt = Date.now();
      persist();
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
      toast(`Watched up to E${n} ✓`);
      break;
    }

    case 'toggle-season': {
      const root = library.find((x) => x.id === detailId);
      if (!root) break;
      /* a folded season is every cour of it — toggle them together */
      const parts = (el.dataset.parts || '').split(',')
        .map((x) => x.split(':').map(Number))
        .filter(([id, t]) => id && t > 0);
      if (!parts.length) break;
      const complete = parts.every(([id, t]) => seasonDone(root, id, t) >= t);
      for (const [id, t] of parts) {
        watchedMap(root)[id] = complete ? [] : Array.from({ length: t }, (_, k) => k + 1);
      }
      persist();
      const st = detailScreen.scrollTop;
      renderDetail();
      detailScreen.scrollTop = st;
      toast(complete ? 'Season marked unwatched' : 'Season marked watched ✓');
      break;
    }

    case 'view-related': {
      if (el.classList.contains('busy')) break;
      const vid = +el.dataset.id;
      const cta = el.querySelector('.rel-cta');
      /* cached → instant, no theatre; uncached → make the wait visible */
      if (!peekCache.has(vid)) {
        el.classList.add('busy');
        if (cta) cta.textContent = 'LOADING…';
        if (el.classList.contains('season-pill')) {
          el.insertAdjacentHTML('beforeend', '<span class="spinner mini pill-spin"></span>');
        }
      }
      try {
        await switchView(vid);
      } catch (err) {
        toast(`Could not load — ${err.message}`, 'err');
        el.classList.remove('busy');
        el.querySelector('.pill-spin')?.remove();
        if (cta) cta.textContent = 'VIEW';
      }
      break;
    }

    case 'refresh-show': {
      const s = library.find((x) => x.id === detailId);
      if (!s) break;
      el.disabled = true;
      el.textContent = 'Refreshing…';
      try {
        await refreshRoot(s);
        const st = detailScreen.scrollTop;
        renderDetail();
        detailScreen.scrollTop = st;
        toast('Data refreshed');
      } catch (err) {
        toast(`Refresh failed — ${err.message}`, 'err');
        el.disabled = false;
        el.textContent = '↻ Refresh';
      }
      break;
    }

    case 'delete-show': {
      const s = library.find((x) => x.id === detailId);
      const ids = s ? groupMemberIds(s) : [detailId];
      if (el.dataset.armed) {
        window.syncUI?.deleted?.(ids);
        library = library.filter((x) => !ids.includes(x.id));
        persist();
        goShelf();
        toast(ids.length > 1 ? `Removed ${ids.length} titles from your shelf` : 'Removed from your shelf');
      } else {
        el.dataset.armed = '1';
        el.textContent = ids.length > 1 ? `Remove all ${ids.length}? Click again` : 'Sure? Click again';
        setTimeout(() => {
          delete el.dataset.armed;
          if (el.isConnected) el.textContent = 'Remove';
        }, 2600);
      }
      break;
    }

    case 'remove-group': {
      const ids = (el.dataset.group || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) break;
      if (el.dataset.armed) {
        window.syncUI?.deleted?.(ids);
        library = library.filter((x) => !ids.includes(x.id));
        persist();
        renderShelf();
        toast(ids.length > 1 ? `Removed ${ids.length} titles from your shelf` : 'Removed from your shelf');
      } else {
        el.dataset.armed = '1';
        el.classList.add('armed');
        el.innerHTML = ids.length > 1 ? `Remove ${ids.length}?` : 'Remove?';
        setTimeout(() => {
          delete el.dataset.armed;
          if (el.isConnected) { el.classList.remove('armed'); el.innerHTML = XMARK; }
        }, 2600);
      }
      break;
    }
  }
});

/* modal dismissal */
searchModal.addEventListener('click', (e) => { if (e.target === searchModal) closeSearch(); });
sourceModal.addEventListener('click', (e) => { if (e.target === sourceModal) closeSourceModal(); });

/* ———————————————————— identify from a screenshot ————————————————————
   trace.moe reverse-image-searches a frame index and answers with AniList
   ids, so a hit feeds straight into the same add path as a text search. */
const idModal = $('#idModal');
let idBusy = false;

function openIdentify() {
  idModal.hidden = false;
  requestAnimationFrame(() => idModal.classList.add('on'));
  idSetStatus('DROP A SCREENSHOT, PASTE ONE, OR CHOOSE A FILE');
  $('#idBody').innerHTML = '';
  refreshTraceQuota();
}
function closeIdentify() {
  idModal.classList.remove('on');
  setTimeout(() => { idModal.hidden = true; }, 200);
}
function idSetStatus(t) { $('#idStatus').textContent = t; }

/* Publish where this machine can be reached so the phone can find it. Rides
   the synced settings row (mediaRoots stay local, this doesn't).

   ALL the LAN addresses go out, not just the best-ranked one: a desktop can
   sit on Ethernet, Wi-Fi and a VPN's virtual adapter at once, and which of
   those the phone can actually route to is not knowable from this end. The
   phone races them. `remoteAddr` stays for older builds. */
async function publishRemote(state) {
  try {
    const ri = state || await window.hikari.remoteInfo?.();
    const addrs = ri?.running ? (ri.ips || []).map((ip) => `http://${ip}:${ri.port}`) : [];
    const next = addrs.length
      ? { remoteAddr: addrs[0], remoteAddrs: addrs, remoteToken: ri.token }
      : { remoteAddr: undefined, remoteAddrs: undefined, remoteToken: undefined };
    const same = appSettings.remoteAddr === next.remoteAddr
      && appSettings.remoteToken === next.remoteToken
      && (appSettings.remoteAddrs || []).join(',') === (next.remoteAddrs || []).join(',');
    if (same) return;
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) delete appSettings[k]; else appSettings[k] = v;
    }
    await window.hikari.saveSettings(appSettings);
    window.syncUI?.push?.();
  } catch { /* never let address bookkeeping break the app */ }
}

/* Shown whenever the service reports one — it is a real constraint, so it
   should be visible rather than sprung on you at zero. Re-read after the key
   changes so adding one updates the figure straight away. */
async function refreshTraceQuota() {
  const el = $('#idQuota');
  if (!el) return;
  try {
    const q = await fetchTraceQuota(appSettings.traceKey || '');
    if (!q) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = `${q.remaining} / ${q.total} SEARCHES LEFT TODAY${q.keyed ? ' · KEY' : ''}`;
    el.title = 'trace.moe allows a fixed number of searches per 24 hours';
    el.classList.toggle('low', q.total > 0 && q.remaining / q.total <= 0.15);
  } catch {
    el.hidden = true;      // never block the feature on a quota lookup
  }
}

function idShowPreview(blob) {
  const img = $('#idPreview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  const url = URL.createObjectURL(blob);
  img.dataset.url = url;
  img.src = url;
  img.hidden = false;
  $('#idHint').hidden = true;
}

async function identifyBlob(blob) {
  if (idBusy) return;
  if (!blob || !String(blob.type || '').startsWith('image/')) { toast('That is not an image', 'err'); return; }
  if (blob.size > 25 * 1024 * 1024) { toast('That image is too large (25 MB max)', 'err'); return; }
  idBusy = true;
  idShowPreview(blob);
  idSetStatus('SEARCHING THE FRAME INDEX…');
  $('#idBody').innerHTML = Array.from({ length: 4 }, () =>
    '<div class="result skel-row"><span class="result-cover skel"></span>'
    + '<span class="result-info"><span class="skel skel-line"></span><span class="skel skel-line short"></span></span></div>').join('');
  try {
    const { results, quota } = await traceMoeSearch(blob, appSettings.traceKey || '');
    refreshTraceQuota();     // authoritative, and reflects a key immediately
    /* pull real cover art so a hit reads like a normal search result */
    let meta = new Map();
    try { meta = await fetchBasics(results.map((r) => r.id)); } catch { /* rows still render */ }
    renderIdentify(results, meta);
  } catch (err) {
    idSetStatus('SEARCH FAILED');
    $('#idBody').innerHTML = `<p class="search-none">${esc(err.message || String(err))}</p>`;
  } finally {
    idBusy = false;
  }
}

function renderIdentify(results, meta) {
  if (!results.length) {
    idSetStatus('NO MATCH');
    $('#idBody').innerHTML = '<p class="search-none">NO MATCH — FRAMES WITH HEAVY TEXT OR EFFECTS OFTEN FAIL</p>';
    return;
  }
  const shelfIds = new Set();
  for (const r of library) franchiseIds(r).forEach((id) => shelfIds.add(id));
  const top = results[0];
  idSetStatus(top.confidence === 'match'
    ? `BEST MATCH — ${Math.round(top.similarity * 100)}% SIMILAR`
    : `NOTHING CONFIDENT — BEST GUESS IS ${Math.round(top.similarity * 100)}%`);

  /* trace.moe always returns its nearest neighbours, so an unindexed frame
     still comes back with confident-looking rows in the 50s. Say so once,
     above the list, rather than dressing them up as answers. */
  const warn = top.confidence === 'match' ? '' :
    `<p class="id-warn">No result cleared the confidence bar. These are the closest frames in the index — they may well be wrong.</p>`;

  $('#idBody').innerHTML = warn + results.map((r, i) => {
    const m = meta.get(r.id) || {};
    const onShelf = shelfIds.has(r.id);
    const bits = [fmtFormat(m.format), m.year, m.episodes ? `${m.episodes} EP` : '',
      m.score ? `★ ${(m.score / 10).toFixed(1)}` : ''].filter(Boolean).join(' · ');
    const where = `${r.episode ? `EP ${esc(String(r.episode))}` : 'MOVIE'} · ${esc(traceStamp(r.from))}`;
    return `
    <div class="result id-result ${r.confidence}" style="animation-delay:${i * 24}ms">
      <span class="result-cover">${m.cover ? `<img src="${esc(m.cover)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <span class="result-info">
        <span class="result-title">
          <span class="tt">${esc(r.title)}</span>
          ${m.dub ? '<i class="r-dub">EN DUB</i>' : ''}
          ${r.isAdult ? '<i class="r-adult">18+</i>' : ''}
        </span>
        <span class="result-meta">${esc(bits)}${bits ? ' · ' : ''}${where}</span>
      </span>
      ${r.scene ? `<img class="id-frame" src="${esc(r.scene)}" alt="" loading="lazy"
          data-action="id-clip" data-clip="${esc(r.clip || '')}" title="Preview the matched scene">` : ''}
      <span class="id-conf" title="How closely the frame matches">${Math.round(r.similarity * 100)}%</span>
      ${onShelf
        ? `<button class="result-badge inlib" data-action="id-open" data-id="${r.id}">ON SHELF</button>`
        : `<button class="result-badge" data-action="id-add" data-id="${r.id}">+ ADD</button>`}
    </div>`;
  }).join('');
}

/* paste works anywhere — that is how a screenshot actually arrives */
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  if (idModal.hidden) openIdentify();
  identifyBlob(item.getAsFile());
});
document.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  if (idModal.hidden) openIdentify();
  $('#idDrop')?.classList.add('over');
});
document.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  $('#idDrop')?.classList.remove('over');
  if (idModal.hidden) openIdentify();
  identifyBlob(f);
});
$('#idFile').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) identifyBlob(f);
  e.target.value = '';
});
$('#idDrop').addEventListener('click', () => $('#idFile').click());
idModal.addEventListener('click', (e) => { if (e.target === idModal) closeIdentify(); });

/* ——— keyboard shortcuts ———
   These already existed; nothing surfaced them. `?` now lists them, and the
   list is the single source of truth for what the app claims to support. */
const SHORTCUTS = [
  ['Ctrl K', 'Search AniList to add a show'],
  ['/', 'Search (same, one key)'],
  ['Ctrl ,', 'Settings'],
  ['?', 'This list'],
  ['Esc', 'Close whatever is open — or go back to the shelf'],
  ['← →', 'Flick through artwork in the art picker'],
  ['Enter', 'Use the highlighted artwork']
];
function openKeys() {
  const grid = $('#keysGrid');
  if (grid) {
    grid.innerHTML = SHORTCUTS.map(([k, what]) => `
      <div class="keys-row">
        <span class="keys-keys">${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</span>
        <span class="keys-what">${esc(what)}</span>
      </div>`).join('');
  }
  $('#keysModal').hidden = false;
  requestAnimationFrame(() => $('#keysModal').classList.add('on'));
}
function closeKeys() {
  const m = $('#keysModal');
  m.classList.remove('on');
  setTimeout(() => { m.hidden = true; }, 180);
}

document.addEventListener('keydown', (e) => {
  /* artwork slider keyboard nav */
  if (!artModal.hidden && ['ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
    e.preventDefault();
    const root = library.find((x) => x.id === artTargetId);
    if (!root) return;
    if (e.key === 'Enter') { artApplyCurrent(); return; }
    const { covers, banners } = artCandidates(root);
    const n = (artKind === 'cover' ? covers : banners).length;
    if (!n) return;
    artIdx = (artIdx + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    updateArtSelection(root, { scrollThumb: true });
    return;
  }

  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (searchModal.hidden) openSearch();
    else closeSearch();
  } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
    e.preventDefault();
    if (settingsModal.hidden) openSettings();
    else closeSettings();
  } else if (e.key === '?' && !typing) {
    e.preventDefault();
    if ($('#keysModal').hidden) openKeys();
    else closeKeys();
  } else if (e.key === 'Escape') {
    if (!$('#keysModal').hidden) closeKeys();
    else if (!idModal.hidden) closeIdentify();
    else if ($('.cmenu')) closeCardMenu();
    else if (!playerModal.hidden) closePlayer();
    else if (!importScreen.hidden) closeImportScreen();
    else if (!scanModal.hidden) closeScanModal();
    else if (!searchModal.hidden) closeSearch();
    else if (!sourceModal.hidden) closeSourceModal();
    else if (!artModal.hidden) closeArtModal();
    else if (!$('#epModal').hidden) closeEpInfo();
    else if (!discModal().hidden) closeDiscPreview();
    else if (!$('#trailerModal').hidden) closeTrailer();
    else if (!settingsModal.hidden) closeSettings();
    else if (detailScreen.classList.contains('active')) goShelf();
  } else if (e.key === '/' && searchModal.hidden && sourceModal.hidden && !typing) {
    e.preventDefault();
    openSearch();
  }
});

/* ———————————————————— boot ———————————————————— */
(async function boot() {
  startShader($('#bg-shader'));
  try {
    library = await window.hikari.getLibrary();
  } catch {
    library = [];
  }
  try {
    appSettings = (await window.hikari.getSettings()) || {};
  } catch {
    appSettings = {};
  }
  if (appSettings.sortMode && SORTS.some(([k]) => k === appSettings.sortMode)) {
    sortMode = appSettings.sortMode;
  }
  hydrateIcons();
  tickClock();
  setInterval(tickClock, 30e3);
  for (const rec of library) {
    for (const [id, p] of Object.entries(rec.peek || {})) peekCache.set(+id, p);
  }
  consolidateLibrary();
  /* backfill default sources for shows added before auto-adoption existed */
  let adoptedAny = false;
  for (const r of library) adoptedAny = autoAdoptSources(r) || adoptedAny;
  if (adoptedAny) persist();
  upgradeTags(); // categories (Harem, Isekai…) for records saved before tags existed
  renderShelf();
  $('#trailerModal').addEventListener('click', (e) => { if (e.target === $('#trailerModal')) closeTrailer(); });
  discModal().addEventListener('click', (e) => { if (e.target === discModal()) closeDiscPreview(); });
  $('#epModal').addEventListener('click', (e) => { if (e.target === $('#epModal')) closeEpInfo(); });
  syncMediaRoots(); // Settings roots + every linked folder (survives restarts now)

  /* background folder watch — first pass once boot has settled, then on a
     timer and whenever the window regains focus (coming back from a download
     is exactly when a new folder tends to exist). Both paths are rate-limited
     inside autoScanTick. */
  /* Relation-type migration (frv 3).
     206 shows x ~3 requests against a 30/min shared budget is ~20 minutes, so
     this is a slow drip in the background rather than a blocking upgrade: one
     show at a time, marked `bg` so anything you are waiting on goes first, and
     it simply stops when there is nothing left. The shelf regroups as records
     land; until one does, that record keeps its old grouping. */
  /* the relation migration lives on the job queue now — see queueRelationMigration */

  /* ——— background work is now jobs ———
     Every sweep below used to be its own timer with its own retry rule and
     no memory across restarts. They are handlers on one queue now: single
     consumer, so the AniList limiter sees one caller; persistent, so an
     interrupted sweep resumes; and visible in the activity panel, so
     "why is this show missing its artwork" has an answer on screen. */
  const J = window.hikariJobs;

  J.register('art', async ({ id }) => {
    const root = library.find((x) => x.id === id);
    if (!root) return;                                   // removed while queued
    if (await fetchPoolInto(root)) {
      persist();
      if (shelfScreen.classList.contains('active')) renderShelf();
      else if (detailScreen.classList.contains('active') && detailId === id) renderDetail();
    }
    const cb = artDone.get(id);
    if (cb) { artDone.delete(id); try { cb(); } catch {} }
  });

  J.register('franchise', async ({ id }) => {
    const rec = library.find((x) => x.id === id);
    if (!rec) return;
    const franchise = await fetchFranchise(id);
    if (franchise.length) { rec.franchise = franchise; rec.frv = FRV_RELATIONS; }
    delete rec.enriching;
    consolidateLibrary();
    persist();
    const active = document.querySelector('.screen.active')?.id;
    if (active === 'screen-detail' && detailId === id) renderDetail();
    else if (active === 'screen-shelf') renderShelf();
    updateChrome();
  });

  J.register('meta', async ({ id }) => {
    const root = library.find((x) => x.id === id);
    if (!root) return;
    await refreshRoot(root);                             // persists internally
    if (shelfScreen.classList.contains('active')) renderShelf();
    else if (detailScreen.classList.contains('active') && detailId === id) renderDetail();
  });

  J.register('identify', async (payload) => { await identifyFolder(payload); });
  J.register('scan', async () => { await autoScanTick(true); });

  J.subscribe(jobsPillPaint);
  J.start();

  /* the relation migration, as a job per show instead of a self-rescheduling
     setTimeout that forgot everything on quit */
  function queueRelationMigration() {
    if (!mayHousekeep()) return;
    for (const r of library) {
      if ((r.franchise || []).length && !hasRelations(r)) {
        J.add('franchise', { id: r.id }, {
          key: `franchise:${r.id}`, priority: 'idle', label: `Seasons · ${r.title}`
        });
      }
    }
  }

  /* Staleness sweep: the Plex/Jellyfin model — nothing waits for you to open
     it. Descriptions, seasons, dub info and artwork all refresh on their own
     schedule, lowest priority, so they never delay anything you asked for. */
  /* Idle housekeeping only runs on the device that holds the role — two
     apps refreshing the same rows is double the API spend for one result.
     Anything the user actually asked for is never gated on this. */
  const mayHousekeep = () => window.syncUI?.isWorker?.() !== false;

  function queueStaleRefresh() {
    if (!mayHousekeep()) return;
    for (const r of library.filter(isStale)) {
      J.add('meta', { id: r.id }, {
        key: `meta:${r.id}`, priority: 'idle', label: `Details · ${r.title}`
      });
    }
    if (appSettings.tmdbKey || appSettings.fanartKey) {
      for (const g of groupEntries(library)) {
        const root = g.rep;
        if (root.artPool?.stamp === artStamp()) continue;
        J.add('art', { id: root.id }, {
          key: `art:${root.id}`, priority: 'idle', label: `Artwork · ${root.title}`
        });
      }
    }
  }

  setTimeout(() => { queueRelationMigration(); queueStaleRefresh(); }, 45000);
  setInterval(queueStaleRefresh, 6 * 60 * 60 * 1000);

  const queueScan = (delay = 0) => J.add('scan', {}, {
    key: 'scan:roots', priority: 'soon', label: 'Scanning media folders', delay
  });
  queueScan(20000);
  setInterval(() => queueScan(), AUTOSCAN_EVERY);
  window.addEventListener('focus', () => queueScan());

  /* Re-publish periodically, not just at boot: a DHCP lease renewal or
     plugging in Ethernet changes the address under us, and until this row
     updates the phone is dialling a machine that has moved. */
  publishRemote();
  setInterval(publishRemote, 60000);

  await autoRefresh();
  checkEpisodeDrops();
  setInterval(checkEpisodeDrops, 30 * 60 * 1000);

  /* the billboard features the newest shows — make sure THEIR art is the good stuff */
  groupEntries(library)
    .sort((a, b) => Math.max(...b.members.map((m) => m.addedAt || 0)) - Math.max(...a.members.map((m) => m.addedAt || 0)))
    .slice(0, 2)
    .forEach((g) => prefetchArtPool(g.rep, () => {
      if (currentView === 'all' && shelfScreen.classList.contains('active')) renderShelf();
    }));
})();
