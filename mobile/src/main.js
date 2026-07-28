/* HIKARI mobile — v3 shell.

   Three structural changes from v2, and every one of them is a bug fix as
   much as a design change:

   1. SCREENS ARE PATCHED, NEVER REBUILT (see render.js). Realtime sync used
      to nuke and re-create the whole screen on every echo from the desktop.
      That is what dismissed the keyboard mid-search, what replayed entry
      animations into a blank gap under the rails, and what made the poster
      wall flash.

   2. TAB SCREENS STAY ALIVE. Leaving the Library and coming back re-shows the
      same DOM with the same scroll offset and the same decoded images —
      nothing to rebuild, nothing to re-animate, nothing to lay out twice.

   3. ONE LIFTED CONTENT WRAPPER (.sc) INSTEAD OF A BLANKET SIBLING RULE.
      `.amb ~ *{position:relative;z-index:1}` had (0,1,0) specificity and sat
      late in the stylesheet, so it silently flattened every positioned
      sibling it touched — the back button, the tab badge, and the season
      dropdown, which is why the dropdown opened *behind* the episode list.
      The ambient layer and the content now live in separate boxes, so there
      is no specificity war left to lose. */
import './styles.css';
import Hls from 'hls.js';
import {
  supa, state, initAuth, pull, pushRecord, addShow, removeShow, fetchSeasonLite, cacheGet, cacheSet,
  saveKeys
} from './store.js';
import {
  searchAnime, seasonlessKey, buildRecord, fetchRecommendations, fetchDubFlags, gql, pickTags,
  traceMoeSearch, traceStamp, fetchBasics, fetchTraceQuota, alBudget
} from './api.js';
import { enrichRecord, isNative, fetchArtPool, fetchFranchise } from './enrich.js';
import { fetchUpcoming } from './api.js';
import { I } from './icons.js';
import { patch, schedule, onScrollFrame, tap, buzz, selectionTick, nextTick } from './render.js';
import {
  esc, cleanSynopsis, computeGroups, foldedSeasons, seasonDisplay, franchisePrimary,
  franchiseShows, showIdOf, hasRelations, FRV_RELATIONS,
  recHasDub, dubInfo, watchedSet, watchedOwner, groupProgress, episodesOf, epCount
} from './fold.js';

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');

/* ————————————————— small helpers ————————————————— */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'err' ? 'err' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); }, 2900);
  setTimeout(() => el.remove(), 3300);
}
const fmtDate = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = (t) => new Date(t).toTimeString().slice(0, 5);
function inWords(ms) {
  const h = Math.round(ms / 36e5);
  if (h < 1) return 'SOON';
  if (h < 24) return `IN ${h}H`;
  const d = Math.round(h / 24);
  return d === 1 ? 'TOMORROW' : `IN ${d} DAYS`;
}

/* ————————————————— app state ————————————————— */
let route = { name: 'lib' };
let stack = [];                      // [{route, el}] — [0] is the tab screen, rest are pushes
let q = '';
let libView = 'all';
let libSort = 'recent';
let libGenres = new Set();
let libTags = new Set();
let filterModal = false;
let synClamped = true;
let findQ = '', findResults = null, findBusy = false, findTimer = null;
/* screenshot identification (trace.moe) */
let idState = null;   // {busy, error, results, preview, quota}
let discPool = null, discGenres = new Set(), discDubs = new Map(), discBusy = false;
let sheet = null;
/* While a detail screen is sliding in, its episode list (25 rows, 25 thumbs)
   is the single biggest chunk of work — building it in the same frame the
   animation starts cost a 121ms stall. Render a light placeholder, then fill
   it once the transition is over. */
let deferHeavy = false;
/* NB: a windowed grid was tried here and measured WORSE (37.7 -> 29.9fps on
   the cold scroll) — growing the window re-patches the screen mid-scroll,
   which costs more than the cards it avoids building. The cold-scroll cost is
   image decode, and that is paid whenever the posters first appear. */

/* ————————————————— remote play (OPTIONAL desktop LAN server) —————————————————
   This app is standalone. Supabase is the single source of truth, every API
   is called directly from the phone, and a record written here is complete —
   nothing waits on a desktop to finish it.

   The one thing a desktop can add is streaming the video files sitting on its
   own disk. That is a bonus, not a dependency, so it is probed LAZILY: only
   when a screen that could offer local playback is actually on screen. It is
   never probed from state.onChange, never on a timer, and never at boot.
   With no desktop published the app does not mention one, and uninstalling
   the desktop app changes nothing here. */
let remoteOk = false;
let remoteEps = new Map();
let remoteProbed = '';        // signature of the last probe
let remoteAt = 0;             // when that probe finished
let remoteBusy = false;
let remoteAddr = '';          // the address that actually answered
let remoteWhy = '';           // why the last attempt failed, for the settings row
const REPROBE_OK = 120000;    // a healthy link is re-checked every 2 min
const REPROBE_BAD = 20000;    // a dead one, rather sooner — but NOT on every event
const canPlay = (partId, n) => remoteOk && remoteEps.get(Number(partId))?.has(n);

/* The desktop may sit on several LAN adapters (Ethernet + Wi-Fi + a VPN's
   virtual one), and only some are reachable from the phone. Older desktops
   publish a single addr; newer ones publish the full list. Race them and keep
   whichever answers first. */
const remoteCandidates = (r) => {
  const list = Array.isArray(r?.addrs) && r.addrs.length ? r.addrs : [r?.addr];
  return [...new Set(list.filter(Boolean))];
};

async function pingAddr(addr) {
  const ping = await fetch(`${addr}/hikari/ping`, { signal: AbortSignal.timeout(4000) }).then((x) => x.json());
  if (ping?.app !== 'hikari') throw new Error('not hikari');
  return addr;                 // deliberately no version check: the wire format is stable
}

/* `force` is the Retry button. Otherwise rate-limited on BOTH outcomes: a
   failure must be retried — a desktop that was merely asleep must not stay
   marked dead — but not on every event, or the timeouts and repaints make the
   app feel frozen. Returns immediately when there is no desktop to look for. */
async function probeRemote(force = false) {
  const r = state.remote;
  if (!r) {
    if (!remoteOk && !remoteEps.size) return;      // nothing published: nothing to do, ever
    remoteOk = false; remoteEps = new Map(); remoteProbed = ''; remoteWhy = '';
    syncSoon();
    return;
  }
  if (remoteBusy) return;
  const sig = `${remoteCandidates(r).join(',')}|${r.token}`;
  const since = Date.now() - remoteAt;
  if (!force && sig === remoteProbed && since < (remoteOk ? REPROBE_OK : REPROBE_BAD)) return;

  remoteBusy = true;
  const was = `${remoteOk}|${remoteAddr}|${remoteEps.size}|${remoteWhy}`;
  try {
    const addr = await Promise.any(remoteCandidates(r).map(pingAddr));
    const man = await fetch(`${addr}/hikari/${r.token}/manifest`, { signal: AbortSignal.timeout(6000) })
      .then((x) => (x.ok ? x.json() : Promise.reject(new Error(x.status === 401 ? 'token rejected' : `HTTP ${x.status}`))));
    const next = new Map();
    for (const [mid, eps] of Object.entries(man.shows || {})) next.set(Number(mid), new Set(eps));
    remoteEps = next;
    remoteAddr = addr;
    remoteOk = true;
    remoteWhy = '';
  } catch (e) {
    remoteOk = false; remoteEps = new Map();
    remoteWhy = /token/.test(e?.message || '') ? e.message : 'no reply';
  } finally {
    remoteBusy = false;
    remoteProbed = sig;
    remoteAt = Date.now();
    /* only repaint when the answer actually moved — an unchanged "still not
       answering" must not cost a full patch of every live screen */
    if (was !== `${remoteOk}|${remoteAddr}|${remoteEps.size}|${remoteWhy}`) syncSoon();
  }
}

/* The ONLY places that ask. Both are screens where the answer is visible:
   a show (are there play buttons?) and Account (is the link healthy?). */
function probeIfRelevant() {
  if (!state.remote) return;
  if (route.name === 'show' || route.name === 'set') probeRemote();
}

/* opening a show is the moment its artwork is worth having */
function prefetchForRoute() {
  if (route.name !== 'show') return;
  const g = findGroup(route.id);
  if (g) prefetchArtPool(g.rep);
}

/* ————————————————— library data ————————————————— */
const SORTS = [
  ['recent', 'Recently watched'],
  ['added', 'Recently added'],
  ['year', 'Newest first'],
  ['title', 'A – Z'],
  ['score', 'Highest rated']
];
/* computeGroups merges franchises with a repeated intersection sweep, and it
   was being re-run by findGroup(), calendarItems(), shelfFranchiseIds() and
   groupsSorted() — many times per render, over 200 records. Cache it against a
   version that only moves when the library actually changes. */
let _groupsCache = null, _groupsKey = '';
const libKey = () => `${state.library.length}:${state.lastSync}`;
function allGroups() {
  const k = libKey();
  if (_groupsCache && _groupsKey === k) return _groupsCache;
  _groupsKey = k;
  _groupsCache = computeGroups(state.library);
  return _groupsCache;
}
function invalidateGroups() { _groupsCache = null; _groupsKey = ''; }

function groupsSorted() {
  const groups = [...allGroups()];
  const byTitle = (a, b) => a.rep.title.localeCompare(b.rep.title);
  const cmp = {
    recent: (a, b) => lastWatched(b) - lastWatched(a) || (b.rep.year || 0) - (a.rep.year || 0) || byTitle(a, b),
    added: (a, b) => Math.max(0, ...b.members.map((m) => m.addedAt || 0)) - Math.max(0, ...a.members.map((m) => m.addedAt || 0)) || byTitle(a, b),
    year: (a, b) => (b.rep.year || 0) - (a.rep.year || 0) || byTitle(a, b),
    title: byTitle,
    score: (a, b) => (b.rep.score || 0) - (a.rep.score || 0) || byTitle(a, b)
  }[libSort] || ((a, b) => (b.rep.year || 0) - (a.rep.year || 0) || byTitle(a, b));
  return groups.sort(cmp);
}
function shelfFranchiseIds() {
  const ids = new Set();
  for (const r of state.library) {
    ids.add(r.id);
    (r.franchise || []).forEach((f) => ids.add(f.id));
    (r.seasons || []).forEach((f) => ids.add(f.id));
  }
  return ids;
}
function findGroup(anyId) {
  return allGroups().find((g) => g.members.some((m) => m.id === anyId) || g.ids.has(anyId));
}
const groupDone = (g) => { const p = groupProgress(g); return p.total > 0 && p.done >= p.total; };
const groupAiring = (g) => g.members.some((m) => m.status === 'RELEASING'
  || Object.values(m.peek || {}).some((p) => p.status === 'RELEASING'));
const groupDub = (g) => g.members.some((m) => recHasDub(m));
const groupFav = (g) => g.members.some((m) => m.favourite);
const lastWatched = (g) => Math.max(0, ...g.members.map((m) => m.lastWatchedAt || 0));

function nextUp(g) {
  for (const se of mobileSeasons(g)) {
    for (const part of se.records) {
      if (part.stub) continue;
      const eps = epCount(part);
      if (!eps) continue;
      const aired = part.nextAiring ? part.nextAiring.episode - 1 : eps;
      const seen = watchedSet(g, part.id);
      for (let n = 1; n <= Math.min(eps, aired); n++) if (!seen.has(n)) return { season: se, part, n };
    }
  }
  return null;
}
const VIEWS = [['all', 'All'], ['unwatched', 'In progress'], ['dub', 'Dubbed'], ['fav', 'Favourites']];
function viewFilter(groups) {
  let out = groups;
  if (libView === 'unwatched') out = out.filter((g) => !groupDone(g) && groupProgress(g).total > 0);
  else if (libView === 'dub') out = out.filter(groupDub);
  else if (libView === 'fav') out = out.filter(groupFav);
  if (libGenres.size) out = out.filter((g) => g.members.some((m) => (m.genres || []).some((c) => libGenres.has(c))));
  if (libTags.size) out = out.filter((g) => g.members.some((m) => (m.tags || []).some((t) => libTags.has(t))));
  return out;
}
const queryFilter = (groups) => (!q ? groups
  : groups.filter((g) => g.members.some((m) => (m.title || '').toLowerCase().includes(q.toLowerCase()))));

/* ————————————————— brand colours (desktop parity) ————————————————— */
const BRANDS = [
  ['crunchyroll', '#F47521'], ['hidive', '#00AEEF'], ['netflix', '#E50914'],
  ['disney', '#113CCF'], ['prime', '#00A8E1'], ['amazon', '#00A8E1'],
  ['hulu', '#1CE783'], ['youtube', '#FF0000'], ['bilibili', '#00A1D6'],
  ['ani-one', '#F0AB00'], ['animax', '#E4002B'], ['hbo', '#8A2BE2'], ['max', '#0032FF']
];
const brandColor = (name) => BRANDS.find(([k]) => String(name || '').toLowerCase().includes(k))?.[1] || '#2A2A33';
function brandText(hex) {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? '#0A0A0C' : '#fff';
}

/* ————————————————— season resolution (detail) ————————————————— */
const liteLoading = new Set();
const liteById = new Map();
function resolvePart(g, id) {
  const owned = g.members.find((m) => m.id === id);
  if (owned) return owned;
  for (const m of g.members) if (m.peek?.[id]) return m.peek[id];
  return liteById.get(id) || null;
}
function mobileSeasons(g) {
  const folded = foldedSeasons(g.rep.franchise?.length ? g.rep.franchise : g.members.map((m) => ({ ...m })));
  const seasons = [];
  for (const se of folded) seasons.push({ ...se, records: se.parts.map((p) => resolvePart(g, p.id) || { ...p, stub: true }) });
  for (const m of g.members) {
    if (!seasons.some((se) => se.parts.some((p) => p.id === m.id))) {
      seasons.push({ key: m.title, format: m.format, num: null, parts: [m], records: [m] });
    }
  }
  return seasons;
}
function viewables(g) {
  const out = [...mobileSeasons(g)];
  for (const f of g.rep.franchise || []) {
    if (out.some((se) => se.parts.some((p) => p.id === f.id))) continue;
    out.push({ key: f.title, format: f.format, num: null, parts: [f],
      records: [resolvePart(g, f.id) || { ...f, stub: true }], extra: true });
  }
  return out;
}
function hydrateStubs(season) {
  for (const r of season.records) {
    if (!r.stub || liteLoading.has(r.id)) continue;
    liteLoading.add(r.id);
    fetchSeasonLite(r.id)
      .then((lite) => { liteById.set(lite.id, lite); syncScreens(); })
      .catch(() => toast('Could not load that season', 'err'))
      .finally(() => liteLoading.delete(r.id));
  }
}
function mutatePart(g, partId, fn) {
  let ownerRec = g.members.find((m) => m.id === partId);
  let target = ownerRec;
  if (!ownerRec) for (const m of g.members) if (m.peek?.[partId]) { ownerRec = m; target = m.peek[partId]; break; }
  if (!ownerRec) { ownerRec = watchedOwner(g, partId); target = null; }
  fn(target || ownerRec, ownerRec);
  pushRecord(ownerRec);
  return ownerRec;
}

/* ═══════════════════════════ SCREENS ═══════════════════════════ */

/* The show's art, blurred, living behind the whole screen. It is pinned
   against scroll by a custom property the scroll handler writes on the screen
   root — NOT an inline transform on this node, which a patch could clobber.
   Nothing here ever animates transform or filter: re-rasterising a full-screen
   18px blur every frame is what made scrolling stutter on device. Opacity on
   an already-composited layer is free. */
/* `art:false` keeps the show's colour but drops the full-screen image.
   MEASURED (6x throttle): the image layer costs the library scroll 104fps ->
   ~44fps, because the whole grid has to blend against it every frame. Behind
   200 posters it is barely visible anyway, so the library gets the free colour
   tint and the detail screen — one show, short scroll — keeps the artwork. */
/* The show's art, blurred, behind the whole screen. Pinned with position:fixed
   (see styles.css) rather than re-translated frame. */
function ambHTML(rec) {
  const src = rec?.cover || rec?.banner || '';
  const tint = rec?.coverColor || '';
  if (!src && !tint) return '';
  return `<div class="amb" data-key="amb" data-vars="--dive">
    ${src ? `<img class="amb-i" src="${esc(src)}" alt="" aria-hidden="true">` : ''}
    ${tint ? `<i class="amb-tint" style="--tint:${esc(tint)}"></i>` : ''}
    <i class="amb-veil"></i>
  </div>`;
}
/* the cheap version: a tint for the screen root, no element, no layer */
const ambTint = (rec) => (rec?.coverColor ? ` style="--tint:${esc(rec.coverColor)}"` : '');
const ptrHTML = () => '<div class="ptr" data-key="ptr" data-vars="--ptr"><i class="ptr-i"></i></div>';

/* —— library —— */
function heroHTML(cw, groups) {
  const seen = new Set();
  const slides = [];
  for (const x of cw.slice(0, 3)) { slides.push(x); seen.add(x.g.rep.id); }
  const airing = groups.find((g) => groupAiring(g) && !seen.has(g.rep.id));
  if (airing) slides.push({ g: airing, nx: null });
  if (!slides.length && groups[0]) slides.push({ g: groups[0], nx: null });
  if (!slides.length) return '';
  const slide = ({ g, nx }) => {
    const r = g.rep;
    const n = nx || nextUp(g);
    const label = nx ? 'Continue watching' : groupAiring(g) ? 'On air now' : 'From your shelf';
    const sd = n ? seasonDisplay(g, n.part) : null;
    return `
    <button class="hero" data-key="hero-${r.id}" data-act="show" data-id="${r.id}" style="--show:${esc(r.coverColor || '#F2F2F4')}">
      <span class="hero-art"><img src="${esc(r.cover || r.banner || '')}" alt=""></span>
      <span class="hero-grad"></span>
      <span class="hero-body">
        <span class="hero-eye"><i></i>${label}</span>
        <b class="hero-title">${esc(r.title)}</b>
        <span class="hero-meta">${n
          ? `Next up · ${sd?.season ? `S${sd.season} ` : ''}Episode ${n.n}`
          : [r.year, r.format].filter(Boolean).map(esc).join(' · ')}</span>
        <span class="hero-cta">${I.play}<em>${n ? 'Resume' : 'Open'}</em></span>
      </span>
    </button>`;
  };
  return `
  <div class="heroc" data-dive data-key="heroc" data-vars="--par --dive">
    <div class="herotrack" data-key="herotrack">${slides.map(slide).join('')}</div>
    ${slides.length > 1 ? `<div class="herodots">${slides.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>` : ''}
  </div>`;
}

function railHTML(title, body, action = '') {
  if (!body) return '';
  return `<section class="rail"><h2 class="rail-h">${esc(title)}${action}</h2>${body}</section>`;
}
function cwRailHTML(cw) {
  if (!cw.length) return '';
  return railHTML('Continue watching', `<div class="hrail">${cw.slice(0, 12).map(({ g, nx }) => {
    const p = groupProgress(g);
    const sd = seasonDisplay(g, nx.part);
    return `
    <button class="cwc" data-key="cw-${g.rep.id}" data-act="show" data-id="${g.rep.id}" style="--show:${esc(g.rep.coverColor || '#fff')}">
      <span class="cwi">
        <img src="${esc(g.rep.banner || g.rep.cover || '')}" loading="lazy" decoding="async" alt="">
        <span class="cwe">${sd.season ? `S${sd.season} ` : ''}E${nx.n}</span>
        <span class="cwplay">${I.play}</span>
        <span class="cwp"><i style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></i></span>
      </span>
      <b>${esc(g.rep.title)}</b>
    </button>`;
  }).join('')}</div>`);
}
function onAirRailHTML() {
  const seen = new Set();
  const items = calendarItems().filter((it) => (seen.has(it.rootId) ? false : (seen.add(it.rootId), true))).slice(0, 12);
  if (!items.length) return '';
  return railHTML('On air', `<div class="hrail">${items.map((it) => `
    <button class="airc" data-key="air-${it.rootId}" data-act="show" data-id="${it.rootId}">
      <span class="api">
        <img src="${esc(it.cover || '')}" loading="lazy" decoding="async" alt="">
        <span class="apw">
          <em class="${it.kind}">${inWords(it.at - Date.now())}</em>
          <span>${it.season ? `S${it.season} · ` : ''}${it.kind.toUpperCase()} E${it.ep}</span>
        </span>
      </span>
      <b>${esc(it.name)}</b>
    </button>`).join('')}</div>`, `<span class="rail-n">${I.broadcast}</span>`);
}

function cardHTML(g) {
  const r = g.rep;
  const p = groupProgress(g);
  const done = p.total > 0 && p.done >= p.total;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  /* Corner budget on a 106px poster is tiny, so each corner gets exactly one
     job: score top-left, status top-right, title along the bottom at full
     width. Completion is the progress bar rather than a third badge — it says
     the same thing and leaves the title alone. */
  return `
  <button class="card" data-key="card-${r.id}" style="--show:${esc(r.coverColor || '#F2F2F4')}"
          data-act="show" data-id="${r.id}" aria-label="${esc(r.title)}">
    <span class="pw">
      <img src="${esc(r.cover || '')}" loading="lazy" decoding="async" alt="">
      <span class="pw-grad"></span>
      ${r.score ? `<span class="score">${I.star}${(r.score / 10).toFixed(1)}</span>` : ''}
      <span class="flags">
        ${groupAiring(g) ? '<i class="badge air">ON AIR</i>' : ''}
        ${groupDub(g) ? '<i class="badge dub">DUB</i>' : ''}
      </span>
      <span class="ptt">${esc(r.title)}</span>
      ${p.total ? `<span class="prog ${done ? 'done' : ''}"><i style="width:${done ? 100 : pct}%"></i></span>` : ''}
    </span>
  </button>`;
}

function libScreen() {
  const groups = groupsSorted();
  const cw = groups.map((g) => ({ g, nx: nextUp(g), at: lastWatched(g) }))
    .filter((x) => x.nx && x.at).sort((a, b) => b.at - a.at);
  const filtered = queryFilter(viewFilter(groups));
  const nf = libGenres.size + libTags.size;
  const narrowed = nf || libView !== 'all' || q;
  const viewLabel = (VIEWS.find(([k]) => k === libView) || [])[1];

  const body = filtered.length
    ? `<div class="grid" data-key="grid">${filtered.map(cardHTML).join('')}</div>`
    : state.library.length
      ? `<div class="empty" data-key="empty">
           <span class="empty-i">${I.find}</span>
           <b>Nothing matches</b>
           <p>${q ? `No shelf title contains “${esc(q)}”.` : 'Try clearing a filter.'}</p>
           ${narrowed ? '<button class="btn-line auto" data-act="clear-all">Reset filters</button>' : ''}
         </div>`
      : `<div class="empty" data-key="empty">
           <span class="empty-i">${I.sparkle}</span>
           <b>Your shelf is syncing</b>
           <p>Fresh account? Add something from the Search tab and it lands on the desktop too.</p>
         </div>`;

  return `
  ${ambHTML((cw[0]?.g || groups[0])?.rep)}
  <div class="sc">
    ${ptrHTML()}
    ${heroHTML(cw, groups)}
    <div class="sechead" data-key="sechead">
      <h2>All shows</h2>
      <span class="sh-n">${filtered.length}${narrowed ? ` of ${groups.length}` : ''}</span>
    </div>
    <i class="bar-anchor" data-key="baranchor"></i>
    <div class="libbar ${narrowed ? 'active' : ''}" data-key="libbar">
      <div class="sfield">
        ${I.find}
        <input id="q" type="search" placeholder="Filter ${groups.length} shows" value="${esc(q)}"
               autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
        ${q ? `<button class="sclr" data-act="q-clear" aria-label="Clear">${I.x}</button>` : ''}
      </div>
      <button class="iconbtn ${libView !== 'all' ? 'on' : ''}" data-act="views" aria-label="View and sort">
        ${I.sliders}${libView !== 'all' ? `<i class="tagdot">${esc(viewLabel)}</i>` : ''}
      </button>
      <button class="iconbtn ${nf ? 'on' : ''}" data-act="filters" aria-label="Filters">
        ${I.funnel}${nf ? `<i class="cnt">${nf}</i>` : ''}
      </button>
    </div>
    ${body}
    ${cwRailHTML(cw)}
    ${onAirRailHTML()}
    <div class="endpad"></div>
  </div>`;
}

/* —— detail —— */
function nextUpHTML(part) {
  const bits = [];
  if (part.status === 'RELEASING' && part.nextAiring?.airingAt) {
    const at = part.nextAiring.airingAt * 1000;
    bits.push(`
    <div class="nu-row">
      <span class="nu-k">${I.broadcast}</span>
      <b>Episode ${part.nextAiring.episode}</b>
      <span class="nu-in">${inWords(at - Date.now())}</span>
      <small>${fmtDate(at)} · ${fmtTime(at)}</small>
    </div>`);
  }
  const di = dubInfo(part);
  if (di) {
    bits.push(`
    <div class="nu-row amber">
      <span class="nu-k">${I.tv}</span>
      <b>${di.nextEp ? `Dub E${di.nextEp}` : 'Dub complete'}</b>
      ${di.nextAt ? `<span class="nu-in">${inWords(di.nextAt - Date.now())}</span>` : ''}
      <small>${di.nextAt ? `${fmtDate(di.nextAt)} · ${fmtTime(di.nextAt)}` : `out to E${di.upTo}`}${di.source === 'manual' ? ' · set' : ''}</small>
      <span class="nu-cal">
        <button class="dadj" data-act="dub-adj" data-part="${part.id}" data-dir="-1" aria-label="Fewer">−</button>
        <button class="dadj" data-act="dub-adj" data-part="${part.id}" data-dir="1" aria-label="More">+</button>
      </span>
    </div>`);
  }
  return bits.length ? `<div class="nextup">${bits.join('')}</div>` : '';
}

function aboutHTML(part, g) {
  const fact = (k, v) => (v ? `<div class="fx"><small>${esc(k)}</small><b>${esc(String(v))}</b></div>` : '');
  const langs = part.dubLanguages || [];
  return `
  <section class="dsec">
    <h2 class="sec-t">About</h2>
    <div class="factgrid">
      ${fact('Premiered', [part.season, part.year].filter(Boolean).join(' ') || null)}
      ${fact('Status', part.status?.replace(/_/g, ' ').toLowerCase())}
      ${fact('Studio', (part.studios || g.rep.studios || [])[0])}
      ${fact('Episode length', part.duration ? `${part.duration} min` : null)}
      ${fact('Score', part.score ? `★ ${(part.score / 10).toFixed(1)}` : null)}
      ${fact('Format', part.format?.replace('_', ' '))}
    </div>
    ${langs.length ? `<div class="langs">${langs.map((l) =>
      `<span class="lang ${l === 'English' ? 'en' : ''}">${esc(l)}</span>`).join('')}</div>` : ''}
  </section>`;
}

/* The watch row is also the divider between the artwork and the page body —
   it sits half on the art, which is what stops the billboard ending in a hard
   horizontal cut. Local files win: if the desktop can stream the next unwatched
   episode the primary action becomes Play and the streams demote to chips. */
function watchRowHTML(g, cur, rec) {
  const src = (rec.sources?.length ? rec.sources : (g.rep.sources || []));
  const pref = (n) => (/crunchyroll/i.test(n) ? 0 : /hidive/i.test(n) ? 1 : 2);
  const links = src.length ? src
    : (rec.streamingLinks || []).slice().sort((a, b) => pref(a.site) - pref(b.site))
      .slice(0, 3).map((l) => ({ name: l.site, url: l.url }));
  let play = null;
  for (const part of cur.records) {
    if (part.stub) continue;
    const eps = epCount(part);
    const aired = part.nextAiring ? part.nextAiring.episode - 1 : eps;
    const seen = watchedSet(g, part.id);
    for (let n = 1; n <= Math.min(eps, aired); n++) {
      if (!seen.has(n) && canPlay(part.id, n)) { play = { partId: part.id, n }; break; }
    }
    if (play) break;
  }
  const trailer = rec.trailer?.id || g.rep.trailer?.id;
  const famCount = franchiseShows(g.rep).length;
  const fav = g.members.some((m) => m.favourite);
  const [first, ...rest] = links;
  const chips = (play && first ? links : rest).map((s) => `
    <a class="srcchip" style="--brand:${brandColor(s.name)}" href="${esc(s.url)}" target="_blank" rel="noreferrer">
      <i></i>${esc(s.name)}</a>`).join('');
  const cta = play
    ? `<button class="watch-cta local" data-act="ep-tap" data-part="${play.partId}" data-n="${play.n}">${I.play}<em>Play E${play.n}</em></button>`
    : first
      ? `<a class="watch-cta" style="--brand:${brandColor(first.name)};--brand-ink:${brandText(brandColor(first.name))}"
            href="${esc(first.url)}" target="_blank" rel="noreferrer">${I.play}<em>${esc(first.name)}</em></a>`
      : '';
  return `
  <div class="watchrow" data-key="watchrow">
    <div class="wr-main">
      ${cta || '<span class="wr-none">No stream linked</span>'}
      <button class="roundbtn ${fav ? 'on' : ''}" data-act="fav" aria-label="Favourite">${fav ? I.heartFill : I.heart}</button>
      <button class="roundbtn" data-act="more-menu" aria-label="More">${I.dots}</button>
    </div>
    ${chips || trailer || famCount > 1 ? `<div class="wr-chips">
      ${chips}
      ${famCount > 1 ? `<button class="ghostchip" data-act="family" data-id="${g.rep.id}">${famCount} in this franchise</button>` : ''}
      ${trailer ? `<a class="ghostchip" href="https://www.youtube.com/watch?v=${esc(trailer)}" target="_blank" rel="noreferrer">Trailer ${I.arrowOut}</a>` : ''}
    </div>` : ''}
  </div>`;
}

function watchOrderHTML(g, curSeason) {
  const fr = g.rep.franchise || [];
  if (fr.length < 2) return '';
  const vs = viewables(g);
  const cards = fr.map((f, i) => {
    const inCur = curSeason.parts.some((p) => p.id === f.id);
    const part = resolvePart(g, f.id);
    const eps = part && !part.stub ? epCount(part) : 0;
    const seenN = eps ? [...watchedSet(g, f.id)].filter((n) => n <= eps).length : 0;
    const done = eps > 0 && seenN >= eps;
    const viewable = vs.find((se) => se.parts.some((p) => p.id === f.id));
    return `
    <button class="woc ${inCur ? 'cur' : ''}" data-key="wo-${f.id}" data-act="season" data-id="${f.id}" ${viewable ? '' : 'disabled'}>
      <span class="wop">
        ${f.cover ? `<img src="${esc(f.cover)}" loading="lazy" decoding="async" alt="">` : ''}
        <i class="won">${i + 1}</i>
        ${done ? `<i class="wod">${I.check}</i>` : ''}
        ${f.dub ? '<i class="wodub">DUB</i>' : ''}
      </span>
      <b>${esc(f.title)}</b>
      <small>${[f.year, f.format?.replace('_', ' ')].filter(Boolean).map(esc).join(' · ')}</small>
    </button>`;
  }).join('');
  return `<section class="dsec"><h2 class="sec-t">Watch order</h2><div class="hrail worail">${cards}</div></section>`;
}

/* Episodes are a VERTICAL list again. The horizontal snap slider looked
   striking and worked badly: reaching E24 meant twenty-four swipes, and a
   list you tick through is the one place in the app that wants to be boring
   and scannable. */
function episodeListHTML(g, cur) {
  let rows = '';
  for (const part of cur.records) {
    if (part.stub) { rows += '<div class="ep-load"><i></i><i></i><i></i></div>'; continue; }
    const eps = episodesOf(part);
    if (cur.records.length > 1 && eps.length) {
      rows += `<div class="partdiv">${esc(part.title.match(/(?:part|cour)\s*\d+\s*$/i)?.[0] || part.title)}</div>`;
    }
    const seen = watchedSet(g, part.id);
    const di = dubInfo(part);
    const allDubbed = recHasDub(part) && part.status !== 'RELEASING';
    const aired = part.nextAiring ? part.nextAiring.episode - 1 : Infinity;
    const owner = watchedOwner(g, part.id);
    rows += eps.map((e, i) => {
      const n = e.number ?? e.n ?? (i + 1);
      const air = e.aired || e.air || '';
      const future = n > aired || (air && Date.parse(air) > Date.now());
      const dubbed = allDubbed || (di && n <= di.upTo);
      const playable = canPlay(part.id, n);
      const isSeen = seen.has(n);
      const pos = owner.playPos?.[part.id]?.[n] || 0;
      const durS = (e.runtime || part.duration || 0) * 60;
      const pct = !isSeen && pos > 30 && durS ? Math.min(96, Math.round((pos / durS) * 100)) : 0;
      const sub = [
        air ? new Date(air).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null,
        e.runtime ? `${e.runtime} min` : null,
        dubbed ? '<span class="db">DUB</span>' : null,
        playable ? '<span class="loc">ON DISK</span>' : null
      ].filter(Boolean).join('<i class="dot"></i>');
      return `
      <div class="epr ${isSeen ? 'seen' : ''} ${future ? 'future' : ''} ${playable ? 'playable' : ''}"
           data-key="ep-${part.id}-${n}" data-act="ep-tap" data-part="${part.id}" data-n="${n}">
        <span class="ep-th">
          ${e.thumbnail ? `<img src="${esc(e.thumbnail)}" loading="lazy" decoding="async" alt="">` : `<span class="ep-ph">${n}</span>`}
          ${playable && !future ? `<span class="ep-play">${I.play}</span>` : ''}
          ${pct ? `<span class="ep-bar"><i style="width:${pct}%"></i></span>` : ''}
        </span>
        <span class="ep-tx">
          <span class="ep-n">Episode ${n}</span>
          <b>${esc(e.title || `Episode ${n}`)}</b>
          ${sub ? `<small>${sub}</small>` : ''}
        </span>
        <button class="tick" data-act="tick" data-part="${part.id}" data-n="${n}"
                aria-label="${isSeen ? 'Mark unwatched' : 'Mark watched'}">${I.check}</button>
      </div>`;
    }).join('');
    if (!eps.length) rows += '<div class="ep-none">No episode list for this one yet.</div>';
  }
  return rows;
}

/* Where to open a show: the first season with anything left to watch, else
   season 1. Opening on whichever member happens to be the shelf record drops
   you into season 4 of something you never started. */
function resumeSeason(g, seasons) {
  for (const se of seasons) {
    const total = se.records.reduce((a, p) => a + epCount(p), 0);
    const seen = se.records.reduce((a, p) => a + [...watchedSet(g, p.id)]
      .filter((n) => n <= (epCount(p) || Infinity)).length, 0);
    if (!total || seen < total) return se;
  }
  return seasons[0];
}

function detailScreen() {
  const g = findGroup(route.id);
  if (!g) return '<div class="sc"><div class="empty"><b>That show is gone.</b><p>It was removed from your shelf.</p></div></div>';
  const seasons = mobileSeasons(g);
  const all = viewables(g);
  const cur = all.find((se) => se.records.some((r) => r.id === route.season)) || resumeSeason(g, seasons) || all[0];
  hydrateStubs(cur);
  const rec = cur.records.find((r) => !r.stub) || cur.records[0] || g.rep;
  const multi = seasons.filter((se) => se.num).length > 1;

  const curEps = cur.records.reduce((a, p) => a + epCount(p), 0);
  const seenN = cur.records.reduce((a, p) => a + [...watchedSet(g, p.id)]
    .filter((n) => n <= (epCount(p) || Infinity)).length, 0);

  /* Season picking is a SHEET, not a dropdown. A dropdown has to out-stack
     everything painted after it; a sheet sits above the whole screen and can
     never lose that fight. */
  const seasel = seasons.length > 1 ? `
  <button class="seasonbtn" data-act="seasons" data-key="seasonbtn">
    <span class="sb-k">Season</span>
    <b>${cur.num && multi ? `Season ${cur.num}` : esc((cur.records[0].title || '').slice(0, 28))}</b>
    <small>${curEps ? `${seenN}/${curEps}` : ''}</small>
    ${I.caretUD}
  </button>` : '';

  const syn = cleanSynopsis(rec.description || g.rep.description);
  const meta = [rec.year, rec.format?.replace('_', ' '),
    `${epCount(rec) || '—'} EP`,
    rec.status === 'RELEASING' ? 'Airing' : null]
    .filter(Boolean).map(esc).join('<i class="dot"></i>');
  const genres = (rec.genres || g.rep.genres || []).slice(0, 5);
  const liveParts = cur.records.filter((p) => !p.stub);
  const airPart = liveParts.find((p) => p.status === 'RELEASING' && p.nextAiring) || liveParts[0];
  const dchips = [
    ...genres.map((x) => ({ t: x, tag: false })),
    ...(rec.tags || g.rep.tags || []).map((x) => ({ t: x, tag: true }))
  ];

  return `
  ${ambHTML(rec.cover ? rec : g.rep)}
  <div class="sc detail" style="--show:${esc(rec.coverColor || g.rep.coverColor || '#F2F2F4')}">
    <!-- sticky, so Back is reachable at any scroll depth instead of leaving
         with the artwork; it turns into a real bar once past the hero -->
    <div class="d-topbar" data-key="dtop">
      <button class="backbtn" data-act="back" aria-label="Back">${I.back}</button>
      <span class="dtb-title">${esc(multi && cur.num ? g.rep.title : (rec.title || g.rep.title))}</span>
      <button class="backbtn ghost" data-act="art-open" aria-label="Artwork">${I.images}</button>
    </div>
    <div class="art" data-dive data-key="art" data-act="art-open" data-vars="--par --dive">
      <span class="art-i"><img src="${esc(bestCover(rec, g.rep))}" alt=""></span>
      <span class="art-grad"></span>
    </div>
    <div class="dhead">
      <h1>${esc(multi && cur.num ? g.rep.title : (rec.title || g.rep.title))}</h1>
      <p class="dmeta">${meta}${recHasDub(rec) ? '<span class="dubtag">EN DUB</span>' : ''}</p>
    </div>
    ${deferHeavy ? '' : watchRowHTML(g, cur, rec)}
    ${deferHeavy ? '' : seasel}
    <div class="ephead" data-key="ephead">
      <h2 class="sec-t">Episodes${cur.num && multi ? ` · S${cur.num}` : ''}</h2>
      <span class="ep-n-count" id="epcount">${seenN}/${curEps || '—'}</span>
    </div>
    <div class="eplist" data-key="eplist-${cur.parts[0].id}">${deferHeavy
      ? '<div class="ep-load"><i></i><i></i><i></i><i></i></div>'
      : episodeListHTML(g, cur)}</div>
    ${deferHeavy || !airPart ? '' : nextUpHTML(airPart)}
    ${syn && !deferHeavy ? `<div class="syn ${synClamped ? 'clamp' : ''}" data-key="syn">
      <p>${esc(syn)}</p>
      <button class="more" data-act="more">${synClamped ? 'Read more' : 'Show less'}</button>
    </div>` : ''}
    ${dchips.length && !deferHeavy ? `<div class="dchips">${dchips.map((c) => c.tag
      ? `<button class="dch tag" data-act="mtag-jump" data-g="${esc(c.t)}">${esc(c.t)}</button>`
      : `<span class="dch">${esc(c.t)}</span>`).join('')}</div>` : ''}
    ${deferHeavy ? '' : watchOrderHTML(g, cur)}
    ${deferHeavy ? '' : aboutHTML(rec, g)}
    <div class="endpad"></div>
  </div>`;
}

/* —— airing —— */
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function calendarItems() {
  const items = [];
  const seen = new Set();
  for (const g of allGroups()) {
    for (const m of g.members) {
      for (const c of [m, ...Object.values(m.peek || {})]) {
        if (c.status !== 'RELEASING' || seen.has(c.id)) continue;
        seen.add(c.id);
        const base = { cover: c.cover || g.rep.cover, ...seasonDisplay(g, c), rootId: g.rep.id };
        if (c.nextAiring?.airingAt) items.push({ ...base, kind: 'sub', ep: c.nextAiring.episode, at: c.nextAiring.airingAt * 1000 });
        const di = dubInfo(c);
        if (di?.nextAt) items.push({ ...base, kind: 'dub', ep: di.nextEp, at: di.nextAt });
      }
    }
  }
  return items.sort((a, b) => a.at - b.at);
}
/* ═══════════════════════════════════════════════════════════════════════
   ANNOUNCEMENTS
   Same idea as the desktop page: a franchise walk already returns future
   entries and AniList marks them NOT_YET_RELEASED. It just doesn't keep a
   usable date — year and month only — so announced entries get their exact
   start date fetched once and cached. A date only counts as confirmed when
   the DAY is known; otherwise the row says what it knows and no more.

   On a phone this is a segment of the Airing tab rather than a sixth tab —
   "what's coming" is one question, over two timescales. */
const annCache = new Map();
let annBusy = false;
let calSeg = 'week';        // 'week' | 'announced'

function announcements() {
  const owned = new Set();
  for (const r of state.library) owned.add(r.id);
  const rows = [];
  const seen = new Set();
  for (const root of state.library) {
    for (const f of root.franchise || []) {
      if (f.status !== 'NOT_YET_RELEASED' || seen.has(f.id)) continue;
      seen.add(f.id);
      const x = annCache.get(f.id) || {};
      rows.push({
        id: f.id, title: f.title || '', format: f.format || '',
        year: f.year ?? null, month: (f.sort || 0) % 100 || null,
        cover: x.cover || f.cover || '', episodes: x.episodes ?? f.episodes ?? null,
        at: x.at ?? null, forShow: root, owned: owned.has(f.id)
      });
    }
  }
  const rank = (r) => (r.at ? 0 : r.month ? 1 : 2);
  return rows.sort((a, c) =>
    rank(a) - rank(c)
    || (a.at && c.at ? a.at - c.at : 0)
    || ((a.year || 9999) - (c.year || 9999))
    || ((a.month || 13) - (c.month || 13))
    || a.title.localeCompare(c.title));
}

async function hydrateAnnouncements() {
  if (annBusy) return;
  const want = announcements().filter((r) => !annCache.has(r.id)).map((r) => r.id);
  if (!want.length) return;
  annBusy = true;
  try {
    for (let i = 0; i < want.length; i += 50) {
      const data = await fetchUpcoming(want.slice(i, i + 50));
      for (const [id, m] of data) annCache.set(id, m);
      syncSoon();
    }
  } catch { /* the list still shows, just without exact dates */ }
  finally { annBusy = false; }
}

const ANN_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function annWhen(r) {
  if (r.at) {
    const d = new Date(r.at);
    const days = Math.ceil((r.at - Date.now()) / 86400e3);
    return { big: `${d.getDate()} ${ANN_MONTHS[d.getMonth()]} ${d.getFullYear()}`,
      small: days <= 0 ? 'any day now' : days === 1 ? 'tomorrow' : days < 30 ? `in ${days} days` : `in ${Math.round(days / 30)} months`,
      firm: true };
  }
  if (r.month && r.year) return { big: `${ANN_MONTHS[r.month - 1]} ${r.year}`, small: 'month confirmed', firm: true };
  if (r.year) return { big: String(r.year), small: 'year only', firm: false };
  return { big: 'TBA', small: 'no date yet', firm: false };
}

function announceHTML() {
  const rows = announcements();
  if (!rows.length) {
    return `<div class="empty"><span class="empty-i">${I.sparkle}</span><b>Nothing announced</b>
      <p>When a show on your shelf gets a new season, film or spin-off confirmed, it turns up here.</p></div>`;
  }
  return `<div class="annlist">${rows.map((r) => {
    const w = annWhen(r);
    const meta = [r.format, r.episodes ? `${r.episodes} EP` : ''].filter(Boolean).join(' · ');
    return `
    <button class="annrow ${w.firm ? 'firm' : ''}" data-key="ann-${r.id}"
            data-act="${r.owned ? 'show' : 'ann-add'}" data-id="${r.id}">
      <img src="${esc(r.cover)}" loading="lazy" decoding="async" alt="">
      <span class="annb">
        <b>${esc(r.title)}</b>
        <span class="annm">${meta ? `${esc(meta)} · ` : ''}from ${esc(r.forShow.title)}</span>
        <span class="annd"><i>${esc(w.big)}</i> ${esc(w.small)}</span>
      </span>
      <span class="anna">${r.owned ? I.check : I.plus}</span>
    </button>`;
  }).join('')}</div>`;
}

function calScreen() {
  const items = calendarItems();
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  let out = '';
  let shown = 0;
  for (const [di, d] of days.entries()) {
    const todays = items.filter((it) => sameDay(new Date(it.at), d));
    if (!todays.length) continue;
    shown += todays.length;
    const byShow = new Map();
    for (const it of todays) {
      const k = `${it.name}|${it.season}`;
      if (!byShow.has(k)) byShow.set(k, { ...it, events: [] });
      byShow.get(k).events.push(it);
    }
    out += `
    <div class="dayblock">
      <h2 class="day ${di === 0 ? 'today' : ''}" data-key="day-${di}">
        <b>${di === 0 ? 'Today' : di === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long' })}</b>
        <span>${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>
      </h2>
      ${[...byShow.values()].map((t) => `
      <button class="ct" data-key="ct-${t.rootId}-${t.events[0].at}" data-act="show" data-id="${t.rootId}">
        <img src="${esc(t.cover || '')}" loading="lazy" decoding="async" alt="">
        <span class="cb">
          <b>${esc(t.name)}</b>
          <span class="line">
            ${t.season ? `<span class="s">S${t.season}</span>` : ''}
            ${t.events.map((e) => `<span class="${e.kind}">${e.kind.toUpperCase()} E${e.ep}</span>`).join('')}
          </span>
        </span>
        <span class="when"><b>${fmtTime(t.events[0].at)}</b><small>${inWords(t.events[0].at - Date.now())}</small></span>
      </button>`).join('')}
    </div>`;
  }
  const annCount = announcements().length;
  return `
  ${ambHTML(items[0] ? { cover: items[0].cover } : null)}
  <div class="sc">
    ${ptrHTML()}
    <h1 class="pgtitle">Airing<span>${calSeg === 'week' ? 'Next 7 days' : 'Confirmed for later'}</span></h1>
    <div class="seg" data-key="calseg">
      <button class="seg-b ${calSeg === 'week' ? 'on' : ''}" data-act="cal-seg" data-seg="week">This week</button>
      <button class="seg-b ${calSeg === 'announced' ? 'on' : ''}" data-act="cal-seg" data-seg="announced">
        Announced${annCount ? ` <i>${annCount}</i>` : ''}</button>
    </div>
    ${calSeg === 'announced' ? announceHTML()
      : shown ? `<div class="cal">${out}</div>`
      : `<div class="empty"><span class="empty-i">${I.clock}</span><b>Nothing airing</b><p>No new episodes or dubs in the next seven days.</p></div>`}
    <div class="endpad"></div>
  </div>`;
}

/* —— discover —— */
const DISC_CAP = 100;
async function buildDiscover(force = false) {
  if (discBusy) return;
  discBusy = true;
  try {
    if (!force) {
      const cached = await cacheGet(`disc.${state.user.id}`);
      if (cached && Date.now() - cached.at < 24 * 36e5) { discPool = cached.items; return; }
    }
    const gs = allGroups();
    const weight = new Map();
    for (const g of gs) {
      const p = groupProgress(g);
      const w = groupFav(g) ? 2 : (p.total && p.done >= p.total) ? 1.5 : p.done > 0 ? 1.2 : 1;
      for (const m of g.members) weight.set(m.id, w);
    }
    const recs = await fetchRecommendations([...weight.keys()]);
    const shelf = shelfFranchiseIds();
    const agg = new Map();
    for (const [srcId, nodes] of recs) {
      const w = weight.get(srcId) || 1;
      for (const n of nodes) {
        const m = n.mediaRecommendation;
        if (shelf.has(m.id) || ['MUSIC', 'SPECIAL'].includes(m.format)) continue;
        const a = agg.get(m.id) || { media: m, pts: 0, n: 0 };
        a.pts += (n.rating || 0) * w;
        a.n++;
        agg.set(m.id, a);
      }
    }
    discPool = [...agg.values()]
      .map((a) => ({ ...a, score: a.pts * (1 + 0.35 * (a.n - 1)) }))
      .sort((a, b) => b.score - a.score).slice(0, DISC_CAP)
      .map((a) => ({
        id: a.media.id, title: a.media.title.english || a.media.title.romaji,
        cover: a.media.coverImage?.large, color: a.media.coverImage?.color,
        year: a.media.seasonYear, format: a.media.format,
        score: a.media.averageScore, genres: a.media.genres || [], n: a.n
      }));
    await cacheSet(`disc.${state.user.id}`, { at: Date.now(), items: discPool });
  } catch (e) {
    toast('Could not build picks — ' + (e.message || e), 'err');
  } finally {
    discBusy = false;
    ensureDiscDubs();
    syncScreens();
  }
}
async function ensureDiscDubs() {
  const want = (discPool || []).filter((p) => !discDubs.has(p.id)).slice(0, 50).map((p) => p.id);
  if (!want.length) return;
  try {
    const flags = await fetchDubFlags(want);
    for (const [id, f] of flags) discDubs.set(id, f);
    syncScreens();
  } catch { /* badges stay off */ }
}
function discScreen() {
  if (!discPool && !discBusy) buildDiscover();
  const head = `<h1 class="pgtitle">Discover<span>Picked from your shelf</span></h1>`;
  if (!discPool) {
    return `<div class="sc">${head}
      <div class="empty"><span class="empty-i spin">${I.sparkle}</span><b>Reading your shelf…</b>
      <p>Asking the community what else you'd like. The first build takes a few seconds.</p></div></div>`;
  }
  const shelf = shelfFranchiseIds();
  const pool = discPool.filter((p) => !shelf.has(p.id));
  const gcount = new Map();
  for (const p of pool) for (const ge of p.genres) gcount.set(ge, (gcount.get(ge) || 0) + 1);
  const topG = [...gcount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([ge]) => ge);
  const visible = pool.filter((p) => !discGenres.size || p.genres.some((ge) => discGenres.has(ge)));
  return `
  ${ambHTML(pool[0] ? { cover: pool[0].cover, coverColor: pool[0].color } : null)}
  <div class="sc">
    ${head}
    <div class="chiprow">
      ${topG.map((ge) => `<button class="chip ${discGenres.has(ge) ? 'on' : ''}" data-key="dg-${esc(ge)}" data-act="disc-genre" data-g="${esc(ge)}">${esc(ge)}</button>`).join('')}
      ${discGenres.size ? `<button class="chip clear" data-act="disc-clear">${I.x}Clear</button>` : ''}
    </div>
    <div class="sechead">
      <h2>${visible.length} pick${visible.length === 1 ? '' : 's'}</h2>
      <button class="txtbtn" data-act="disc-regen">${I.refresh}Regenerate</button>
    </div>
    <div class="grid wide">${visible.map((p) => `
      <button class="card capd" data-key="disc-${p.id}" style="--show:${esc(p.color || '#fff')}" data-act="preview" data-id="${p.id}">
        <span class="pw">
          <img src="${esc(p.cover || '')}" loading="lazy" decoding="async" alt="">
          ${discDubs.get(p.id) ? '<span class="badge dub">DUB</span>' : ''}
          ${p.score ? `<span class="score">${I.star}${(p.score / 10).toFixed(1)}</span>` : ''}
        </span>
        <span class="cap"><b>${esc(p.title)}</b><small>${[p.year, p.format].filter(Boolean).map(esc).join(' · ')}</small></span>
      </button>`).join('')}</div>
    <div class="endpad"></div>
  </div>`;
}

/* —— search —— */
function findScreen() {
  const shelf = shelfFranchiseIds();
  let body = '';
  if (findBusy && !findResults) {
    body = `<div class="rlist">${Array.from({ length: 6 }, () => '<div class="rskel"><i></i><span><b></b><em></em></span></div>').join('')}</div>`;
  } else if (findResults) {
    const byKey = new Map();
    for (const m of findResults) {
      const k = seasonlessKey(m);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(m);
    }
    const rows = [...byKey.values()].map((list) => {
      const rep = list.find((m) => shelf.has(m.id))
        || list.find((m) => m.format === 'TV')
        || list.slice().sort((a, b) => (a.seasonYear || 9999) - (b.seasonYear || 9999))[0];
      const owned = list.some((m) => shelf.has(m.id));
      return `
      <button class="rrow" data-key="r-${rep.id}" data-act="${owned ? 'open-owned' : 'preview'}" data-id="${rep.id}">
        <img src="${esc(rep.coverImage?.large || '')}" loading="lazy" decoding="async" alt="">
        <span class="rb">
          <b>${esc(rep.title.english || rep.title.romaji)}${rep.dub ? '<span class="rdub">DUB</span>' : ''}</b>
          <small>${[rep.seasonYear, rep.format, rep.episodes ? `${rep.episodes} EP` : null].filter(Boolean).map(esc).join('<i class="dot"></i>')}
            ${list.length > 1 ? `<span class="rse">${list.length} seasons</span>` : ''}</small>
        </span>
        <span class="rtag ${owned ? 'own' : ''}">${owned ? I.check : I.plus}</span>
      </button>`;
    }).join('');
    body = rows ? `<div class="rlist">${rows}</div>`
      : `<div class="empty"><span class="empty-i">${I.find}</span><b>No results</b><p>Nothing on AniList matches “${esc(findQ)}”.</p></div>`;
  } else {
    body = `<div class="empty"><span class="empty-i">${I.find}</span><b>Search AniList</b>
      <p>Anything you add here syncs straight to the desktop app.</p></div>`;
  }
  /* Seeing a clip and not knowing what it is is the whole reason this exists,
     so it sits above the results rather than behind a menu. */
  const idBlock = idState ? identifyHTML() : `
    <button class="id-cta" data-act="id-source">
      <span class="id-cta-i">${I.images}</span>
      <span class="id-cta-t"><b>What anime is this?</b>
        <small>Identify it from an image</small></span>
      ${I.caretR}
    </button>`;
  return `
  <div class="sc">
    <h1 class="pgtitle">Search</h1>
    <i class="bar-anchor" data-key="baranchor"></i>
    <div class="libbar solo" data-key="findbar">
      <div class="sfield big">
        ${I.find}
        <input id="fq" type="search" placeholder="Search anime to add…" value="${esc(findQ)}"
               autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
        ${findQ ? `<button class="sclr" data-act="fq-clear" aria-label="Clear">${I.x}</button>` : ''}
      </div>
    </div>
    ${idBlock}
    ${body}
    <div class="endpad"></div>
  </div>`;
}

/* ——— identify from a screenshot ———
   trace.moe reverse-image-searches a frame index and answers with AniList
   ids — the same key a record is built on — so a hit goes straight into the
   existing preview/add sheet. */
function identifyHTML() {
  const st = idState;
  const head = `
    <div class="id-head">
      <b>What anime is this?</b>
      <button class="id-x" data-act="id-clear" aria-label="Clear">${I.x}</button>
    </div>`;
  if (st.busy) {
    return `<div class="idbox">${head}
      ${st.preview ? `<img class="id-shot" src="${esc(st.preview)}" alt="">` : ''}
      <p class="id-note"><span class="id-spin"></span>Searching the frame index…</p></div>`;
  }
  if (st.error) {
    return `<div class="idbox">${head}
      <p class="id-note err">${esc(st.error)}</p>
      <button class="btn-line auto" data-act="id-source">Try another image</button></div>`;
  }
  const rs = st.results || [];
  if (!rs.length) {
    return `<div class="idbox">${head}
      ${st.preview ? `<img class="id-shot" src="${esc(st.preview)}" alt="">` : ''}
      <p class="id-note">No match. Frames with heavy text or effects over them often fail.</p>
      <button class="btn-line auto" data-act="id-source">Try another image</button></div>`;
  }
  const shelf = shelfFranchiseIds();
  const top = rs[0];
  /* trace.moe always returns its nearest neighbours, so an unindexed frame
     still comes back with confident-looking rows in the 50s. Say so. */
  const warn = top.confidence === 'match' ? '' :
    `<p class="id-warn">Nothing cleared the confidence bar — these are just the
      closest frames in the index, so they may well be wrong.</p>`;
  /* the cap is a real constraint, so it stays visible rather than appearing
     only at zero; trace.moe's window is 24 hours */
  const low = st.quota
    ? `<p class="id-quota ${st.quota.remaining / (st.quota.total || 1) <= 0.15 ? 'low' : ''}">${st.quota.remaining} / ${st.quota.total} searches left today${st.quota.keyed ? ' · key' : ''}</p>`
    : '';
  /* rows are the SAME component as a search result, plus a confidence chip */
  return `<div class="idbox">${head}
    ${st.preview ? `<img class="id-shot" src="${esc(st.preview)}" alt="">` : ''}
    ${warn}${low}
    <div class="rlist flush">${rs.map((r) => {
      const m = st.meta?.[r.id] || {};
      const owned = shelf.has(r.id);
      const bits = [m.format, m.year, m.episodes ? `${m.episodes} EP` : ''].filter(Boolean).join('<i class="dot"></i>');
      return `
      <button class="rrow" data-key="id-${r.id}" data-act="${owned ? 'open-owned' : 'preview'}" data-id="${r.id}">
        <img src="${esc(m.cover || r.scene || '')}" loading="lazy" decoding="async" alt="">
        <span class="rb">
          <b>${esc(r.title)}${m.dub ? '<span class="rdub">DUB</span>' : ''}</b>
          <small>${bits}${bits ? '<i class="dot"></i>' : ''}${r.episode ? `EP ${esc(String(r.episode))}` : 'MOVIE'}<i class="dot"></i>${esc(traceStamp(r.from))}</small>
        </span>
        <span class="id-conf ${r.confidence}">${Math.round(r.similarity * 100)}%</span>
      </button>`;
    }).join('')}</div>
    <button class="btn-line auto" data-act="id-source">Try another image</button>
  </div>`;
}

/* One hidden picker, reused. Plain `accept` lets Android offer the gallery
   (and usually the camera among the choices); `capture` jumps straight to the
   rear camera, which is what you want when the anime is on a TV in front of
   you rather than in your camera roll. */
let idInput = null;
function pickIdentifyImage(useCamera = false) {
  if (!idInput) {
    idInput = document.createElement('input');
    idInput.type = 'file';
    idInput.accept = 'image/*';
    idInput.style.display = 'none';
    document.body.appendChild(idInput);
    idInput.addEventListener('change', () => {
      const f = idInput.files?.[0];
      idInput.value = '';
      if (f) identifyImage(f);
    });
  }
  if (useCamera) idInput.setAttribute('capture', 'environment');
  else idInput.removeAttribute('capture');
  idInput.click();
}

/* Android share target (see MainActivity.java): a screenshot shared from
   YouTube arrives here as a data: URL. Jump to Search and identify it — the
   whole point is that it takes no further taps. */
window.__hikariShared = async (dataUrl) => {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (route.name !== 'find') navigate({ name: 'find' }, 'tab');
    await identifyImage(new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' }));
  } catch (e) {
    toast('Could not read the shared image', 'err');
  }
};

/* live quota; never allowed to break the feature if it fails */
async function traceQuota() {
  try { return await fetchTraceQuota(state.keys.traceKey || ''); } catch { return null; }
}

async function identifyImage(file) {
  if (!String(file.type || '').startsWith('image/')) { toast('That is not an image', 'err'); return; }
  if (file.size > 25 * 1024 * 1024) { toast('That image is too large (25 MB max)', 'err'); return; }
  if (idState?.preview) URL.revokeObjectURL(idState.preview);
  idState = { busy: true, preview: URL.createObjectURL(file), results: null, error: null };
  syncScreens();
  try {
    const { results, quota } = await traceMoeSearch(file, state.keys.traceKey || '');
    /* real cover art, so a hit reads like a normal search result */
    let meta = {};
    try {
      const m = await fetchBasics(results.map((r) => r.id));
      for (const [id, v] of m) meta[id] = v;
    } catch { /* rows still render off the scene thumb */ }
    idState = { ...idState, busy: false, results, meta, quota: await traceQuota() };
    if (results.length && results[0].confidence === 'match') buzz();
  } catch (err) {
    idState = { ...idState, busy: false, error: err.message || String(err) };
  }
  syncScreens();
}

function runFind() {
  const term = findQ.trim();
  if (term.length < 3) { findResults = null; findBusy = false; syncScreens(); return; }
  findBusy = true;
  syncScreens();
  searchAnime(term)
    .then((res) => { findResults = res; })
    .catch((e) => { findResults = []; toast(String(e.message || e), 'err'); })
    .finally(() => { findBusy = false; syncScreens(); });
}

/* —— account —— */
function setScreen() {
  const gs = allGroups();
  const watched = state.library.reduce((a, r) => a + Object.values(r.watched || {}).reduce((x, l) => x + l.length, 0), 0);
  const stat = (v, k) => `<div class="stat"><b>${esc(String(v))}</b><small>${esc(k)}</small></div>`;
  return `
  <div class="sc">
    <h1 class="pgtitle">Account</h1>
    <div class="acct">
      <span class="avatar">${(state.user.email || '?').slice(0, 1).toUpperCase()}</span>
      <span class="acct-t">
        <b>${esc(state.user.email || '')}</b>
        <small>${state.lastSync ? `Synced ${new Date(state.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet'}</small>
      </span>
    </div>
    <div class="statrow">
      ${stat(gs.length, 'Shows')}
      ${stat(state.library.length, 'Seasons')}
      ${stat(watched.toLocaleString(), 'Episodes seen')}
    </div>
    <div class="srows">
      <button class="srow" data-act="syncnow"><span class="si">${I.cloud}</span><b>Sync now</b><i>${I.caretR}</i></button>
      ${bio ? `<button class="srow" data-act="bio-toggle"><span class="si">${I.fingerprint}</span><b>Fingerprint lock</b><span class="tgl ${bioEnabled() ? 'on' : ''}"><i></i></span></button>` : ''}
      <button class="srow" data-act="disc-regen"><span class="si">${I.refresh}</span><b>Rebuild discover picks</b><i>${I.caretR}</i></button>
      <button class="srow" data-act="keys-open"><span class="si">${I.images}</span><b>Artwork &amp; API keys</b>
        <small class="srow-v">${keysSetCount()}</small><i>${I.caretR}</i></button>
    </div>
    <div class="srows">
      <button class="srow danger" data-act="signout"><span class="si">${I.signOut}</span><b>Sign out</b></button>
    </div>
    <!-- An optional extra, never a fault: with no desktop this app is complete,
         it simply has no local video files to stream. -->
    <div class="remote ${state.remote ? (remoteOk ? 'ok' : 'off') : 'none'}">
      <span class="si">${remoteBusy ? I.refresh : remoteOk ? I.checkFill : state.remote ? I.warning : I.tv}</span>
      <span>
        <b>${remoteBusy ? 'Checking…' : remoteOk ? 'Streaming from desktop' : state.remote ? 'Desktop not answering' : 'Local file streaming'}</b>
        <small>${state.remote
          ? remoteOk
            ? `${esc(remoteAddr)} — ${remoteEps.size} seasons playable on this phone`
            : `${esc(remoteCandidates(state.remote).join(', '))} — ${remoteWhy === 'token rejected'
                ? 'the desktop rejected this phone’s key; rotate it there and sync'
                : 'is Hikari open, on the same Wi-Fi, and is the phone off VPN?'}`
          : 'Optional. Run the desktop app on the same Wi-Fi to play its video files here — everything else works without it.'}</small>
      </span>
      ${state.remote && !remoteBusy
        ? `<button class="remote-retry" data-act="remote-retry">Retry</button>` : ''}
    </div>
    <p class="note">Your library, progress and settings live in your account and sync to every device
      signed into it. This app talks to AniList and the artwork services directly.</p>
    ${diagnosticsHTML()}
    <div class="endpad"></div>
  </div>`;
}

/* ——— API keys ———
   These used to be desktop-only, which meant the phone could never fetch its
   own artwork. They live in the account's settings row, so setting one here
   covers every device. All optional: without them the app falls back to
   AniList's own covers and banners. */
const KEY_META = [
  {
    k: 'tmdbKey', label: 'TMDB',
    hint: 'Posters and full-bleed backdrops. Free key from themoviedb.org → Settings → API.',
    ph: 'v3 API key'
  },
  {
    k: 'fanartKey', label: 'fanart.tv',
    hint: 'Community HD posters and backgrounds. Free personal key from fanart.tv.',
    ph: 'Project key'
  },
  {
    k: 'traceKey', label: 'trace.moe',
    hint: 'Raises the daily limit on Identify. Only issued to project supporters — leave empty otherwise.',
    ph: 'Optional key'
  }
];
function keysSetCount() {
  const n = KEY_META.filter((m) => state.keys[m.k]).length;
  return n ? `${n} set` : 'None set';
}
function keysSheetHTML(wrap) {
  return wrap('Artwork & API keys', `
    <p class="sh-note">All optional, all shared with your other devices. Without them
      Hikari uses AniList’s own artwork.</p>
    ${KEY_META.map((m) => `
      <label class="keyf">
        <span class="keyf-l">${esc(m.label)}</span>
        <input type="text" inputmode="text" autocomplete="off" autocapitalize="none"
          spellcheck="false" data-keep data-key-field="${m.k}" placeholder="${esc(m.ph)}"
          value="${esc(state.keys[m.k] || '')}">
        <small>${esc(m.hint)}</small>
      </label>`).join('')}
    <div class="sh-btns">
      <button class="btn-solid" data-act="keys-save" ${sheet.busy ? 'disabled' : ''}>
        ${sheet.busy ? 'Saving…' : 'Save'}</button>
    </div>`, 'tall');
}

/* Folded away by default — it exists so a problem on the phone can be read
   off the screen instead of guessed at from a description. */
function diagnosticsHTML() {
  const b = alBudget();
  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const rows = [
    ['Library', `${state.library.length} records`],
    ['Last sync', state.lastSync ? ago(state.lastSync) : 'never'],
    ['Desktop', state.remote
      ? (remoteOk ? `reachable · ${remoteAddr}` : `not answering · ${remoteWhy || 'no reply'}`)
      : 'no server published'],
    ['AniList budget', b.remaining == null ? 'unknown' : `${b.remaining} left this minute`],
    ['AniList queue', `${b.queued} waiting${b.waitingOnUser ? ' (one is yours)' : ''}`],
    ['App', `${__APP_VERSION__}${isNative() ? ' · device' : ' · browser'}`]
  ];
  return `
  <details class="diag">
    <summary>Diagnostics</summary>
    <div class="diag-b">
      ${rows.map(([k, v]) => `<p><b>${esc(k)}</b><span>${esc(String(v))}</span></p>`).join('')}
      ${lastErrors.length
        ? `<p class="diag-h"><b>Recent errors</b></p>`
          + lastErrors.map((e) => `<p class="diag-e">${esc(new Date(e.at).toLocaleTimeString())} — ${esc(e.msg)}</p>`).join('')
        : '<p class="diag-e">No errors recorded.</p>'}
      <button class="btn-line auto" data-act="diag-copy">Copy for a bug report</button>
    </div>
  </details>`;
}

/* ————————————————— categories backfill ————————————————— */
let tagsBackfilled = false;
async function backfillTags() {
  if (tagsBackfilled || !state.library.length) return;
  const missing = state.library.filter((r) => !('tags' in r) && Number.isFinite(r.id));
  if (!missing.length) { tagsBackfilled = true; return; }
  tagsBackfilled = true;
  const Q = `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { id tags { name rank isMediaSpoiler isAdult } } } }`;
  try {
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const data = await gql(Q, { ids: batch.map((r) => r.id) }, { bg: true });
      const byId = new Map((data.Page.media || []).map((m) => [m.id, m.tags]));
      for (const r of batch) r.tags = pickTags(byId.get(r.id));
    }
    syncScreens();
  } catch { tagsBackfilled = false; }
}
function filterIndexes() {
  const gCounts = new Map(), tCounts = new Map();
  for (const g of allGroups()) {
    for (const c of new Set(g.members.flatMap((m) => m.genres || []))) gCounts.set(c, (gCounts.get(c) || 0) + 1);
    for (const c of new Set(g.members.flatMap((m) => m.tags || []))) tCounts.set(c, (tCounts.get(c) || 0) + 1);
  }
  return {
    genres: [...gCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    tags: [...tCounts.entries()].filter(([, n]) => n >= 2).sort((a, b) => a[0].localeCompare(b[0]))
  };
}

/* ————————————————— on-device enrichment ————————————————— */
const enriching = new Set();
const isLiteRec = (r) => r && ((r.epv || 0) < 1 || !('franchise' in r));
async function enrichAdded(id, quiet = false) {
  if (enriching.has(id)) return;
  enriching.add(id);
  try {
    const rec = state.library.find((r) => r.id === id);
    if (!rec) return;
    const fresh = await enrichRecord(rec);
    const idx = state.library.findIndex((r) => r.id === id);
    if (idx < 0) return;
    state.library[idx] = fresh;
    pushRecord(fresh);
    state.onChange();
    if (!quiet) toast(`${fresh.title} — seasons & episodes filled in`);
  } catch (e) {
    console.warn('[enrich]', e.message || e);
  } finally { enriching.delete(id); }
}
let bootEnrichDone = false;
async function bootEnrich() {
  if (bootEnrichDone || !isNative() || !state.library.length) return;
  bootEnrichDone = true;
  for (const r of state.library.filter(isLiteRec).slice(0, 4)) await enrichAdded(r.id, true);
}

/* ————————————————— biometric lock (native only) ————————————————— */
let bio = null;
let bioChecking = false;
let lastBackground = 0;
const bioEnabled = () => localStorage.getItem('hikariBioLock') === '1';
async function bioInit() {
  try {
    if (!isNative()) return;
    const mod = await import('@aparajita/capacitor-biometric-auth');
    const info = await mod.BiometricAuth.checkBiometry();
    if (info?.isAvailable) bio = mod.BiometricAuth;
  } catch { /* plugin absent or web */ }
}
async function bioVerify() {
  if (bioChecking) return;
  bioChecking = true;
  try {
    await bio.authenticate({
      reason: 'Unlock Hikari', androidTitle: 'Unlock Hikari',
      androidConfirmationRequired: false, allowDeviceCredential: true, cancelTitle: 'Cancel'
    });
    const w = $('#lockwrap');
    if (w) { w.classList.add('out'); setTimeout(() => w.remove(), 260); }
  } catch (e) {
    const code = e?.code || '';
    if (!/userCancel|systemCancel|appCancel/i.test(code)) toast(`Unlock failed — ${e?.message || code || 'unknown'}`, 'err');
  }
  /* the prompt itself backgrounds the app — give appStateChange a beat so the
     resume it triggers is never mistaken for a real return */
  setTimeout(() => { bioChecking = false; }, 800);
}
function showLock() {
  if (!bio || !bioEnabled() || $('#lockwrap')) return;
  closePlayer(false);
  document.body.insertAdjacentHTML('beforeend', `
  <div class="lockwrap" id="lockwrap">
    <span class="lk-mark">${I.lib}</span>
    <p class="mark">HIKARI<i>·</i>ヒカリ</p>
    <p class="lk-sub">Locked</p>
    <button class="btn-solid lk-btn" data-act="bio-unlock">${I.fingerprint}Unlock</button>
    <button class="lk-out" data-act="signout">Sign out</button>
  </div>`);
  bioVerify();
}
import('@capacitor/app').then(({ App }) => {
  App.addListener('appStateChange', ({ isActive }) => {
    /* coming back is when the desktop may have woken or the Wi-Fi changed —
       but only worth asking if a screen is showing the answer */
    if (isActive) probeIfRelevant();
    if (bioChecking) return;
    if (!isActive) { lastBackground = Date.now(); return; }
    if (state.user && bio && bioEnabled() && lastBackground && Date.now() - lastBackground > 20000) showLock();
  });
}).catch(() => {});

/* ————————————————— poster → billboard morph (FLIP) ————————————————— */
const ART_H = () => Math.min(innerHeight * 0.5, 430);
let morphEl = null;

/* evaluate a CSS cubic-bezier timing function in JS (Newton, then bisect) */
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = fx(t) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    t = Math.min(1, Math.max(0, t));
    return ((ay * t + by) * t + cy) * t;
  };
}
function startMorph(fromCard) {
  if (reduceMotion()) return;
  const img = fromCard?.querySelector('.pw img');
  if (!img?.src || !img.naturalWidth) return;
  morphEl?.remove();
  const r = img.getBoundingClientRect();
  const W = innerWidth, H = ART_H();

  /* A poster is 2:3 and the billboard is roughly 1:1.15, so anything morphing
     between them has to change X and Y by different amounts — which stretches
     the artwork for the whole flight. Instead: an OUTER clip box takes the
     non-uniform scale (it's an invisible frame, distorting it costs nothing)
     while the INNER image counter-scales so its own on-screen scale stays
     uniform. The art never distorts; the frame just reveals more of it,
     exactly like object-fit:cover does at both ends.

     The two scales have to cancel at EVERY frame, and `max()` isn't linear, so
     letting CSS interpolate them independently still left ~10% stretch early
     on. The geometry is therefore evaluated at a dozen points along the easing
     curve and handed to WAAPI as explicit keyframes: uniform by construction,
     and still a composited transform-only animation. */
  const m = document.createElement('div');
  m.className = 'morph';
  const im = document.createElement('img');
  im.src = img.src;
  m.appendChild(im);
  m.style.width = `${W}px`;
  m.style.height = `${H}px`;
  document.body.appendChild(m);
  morphEl = m;

  const ease = cubicBezier(0.22, 1, 0.36, 1);      // matches --e-out
  const N = 14;
  const box = [], art = [];
  for (let i = 0; i < N; i++) {
    const e = ease(i / (N - 1));
    const w = r.width + (W - r.width) * e;
    const h = r.height + (H - r.height) * e;
    const x = r.left * (1 - e);
    const y = r.top * (1 - e);
    const sx = w / W, sy = h / H, u = Math.max(sx, sy);
    box.push({ transform: `translate(${x.toFixed(2)}px,${y.toFixed(2)}px) scale(${sx.toFixed(5)},${sy.toFixed(5)})` });
    art.push({ transform: `scale(${(u / sx).toFixed(5)},${(u / sy).toFixed(5)})` });
  }
  const opts = { duration: 420, easing: 'linear', fill: 'forwards' };
  m.animate(box, opts);
  im.animate(art, opts);

  setTimeout(() => m.classList.add('fade'), 380);
  setTimeout(() => { if (morphEl === m) morphEl = null; m.remove(); }, 640);
}

/* ————————————————— per-show colour into the chrome ————————————————— */
function setChrome(color) {
  document.documentElement.style.setProperty('--chrome', color || 'transparent');
  document.documentElement.classList.toggle('themed', !!color);
}
const chromeFor = (r) => {
  if (r?.name !== 'show') return null;
  const g = findGroup(r.id);
  return g ? (g.rep.coverColor || g.members.find((m) => m.coverColor)?.coverColor || null) : null;
};

/* ————————————————— artwork pools —————————————————
   Built ON THIS DEVICE. Previously the phone could only display a pool the
   desktop had already synced in, which meant no desktop, no artwork. The
   stamp records which keys the pool was built with, so adding a key later
   rebuilds it rather than leaving the thin AniList-only version in place. */
const artStamp = () =>
  `v3:${state.keys.tmdbKey ? 't' : ''}${state.keys.fanartKey ? 'f' : ''}`;
const artPoolAttempted = new Set();

async function prefetchArtPool(root) {
  if (!root?.idMal) return;
  if (root.artPool?.stamp === artStamp() || artPoolAttempted.has(root.id)) return;
  artPoolAttempted.add(root.id);
  try {
    const ids = [root.id, ...(root.franchise || []).map((f) => f.id)];
    const pool = await fetchArtPool(ids, root.idMal, {
      tmdb: state.keys.tmdbKey || '', fanart: state.keys.fanartKey || ''
    });
    if (!pool.covers.length && !pool.banners.length) return;
    pool.stamp = artStamp();
    const rec = state.library.find((r) => r.id === root.id);
    if (!rec) return;
    rec.artPool = pool;
    pushRecord(rec);
    syncSoon();
  } catch { /* the lightbox still has AniList art */ }
}

/* Old pools stored w1280 URLs; serve the original instead. */
const hiRes = (u) => String(u || '').replace('image.tmdb.org/t/p/w1280', 'image.tmdb.org/t/p/original');
const bestCover = (rec, root) =>
  hiRes(rec?.artCover || rec?.cover || root?.artPool?.covers?.[0] || rec?.banner || root?.cover || '');

/* ————————————————— artwork lightbox ————————————————— */
let artView = null;
function openArt() {
  const g = findGroup(route.id);
  if (!g) return;
  const all = viewables(g);
  const cur = all.find((se) => se.records.some((r) => r.id === route.season)) || all[0];
  const rec = cur?.records.find((r) => !r.stub) || g.rep;
  const root = g.rep;
  const imgs = [...new Set([
    rec.banner, rec.cover,
    ...(root.artPool?.banners || []), ...(root.artPool?.covers || []),
    ...(root.franchise || []).map((f) => f.banner).filter(Boolean)
  ].filter(Boolean))].slice(0, 16);
  if (!imgs.length) return;
  artView = { imgs, idx: 0 };
  renderArt(true);
}
function renderArt(animateIn = false) {
  const host = $('#arthost');
  if (!host) return;
  if (!artView) {
    const a = $('#artview');
    if (a) { a.classList.remove('on'); setTimeout(() => { host.textContent = ''; }, 260); }
    return;
  }
  const { imgs, idx } = artView;
  const html = `
  <div class="artview" id="artview">
    <img src="${esc(imgs[idx])}" alt="">
    <div class="av-top">
      <span class="av-n">${idx + 1} / ${imgs.length}</span>
      <button class="av-x" data-act="art-close" aria-label="Close">${I.x}</button>
    </div>
    ${imgs.length > 1 ? `
    <button class="av-zone l" data-act="art-nav" data-dir="-1" aria-label="Previous">${I.back}</button>
    <button class="av-zone r" data-act="art-nav" data-dir="1" aria-label="Next">${I.caretR}</button>` : ''}
  </div>`;
  if ($('#artview')) { patch(host, html); return; }
  host.innerHTML = html;
  const a = $('#artview');
  if (animateIn) nextTick(a, () => a.classList.add('on'));
  else a.classList.add('on');
  let sx = 0, sy = 0;
  a.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  a.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (dy > 90 && Math.abs(dx) < 70) { artView = null; renderArt(); return; }
    if (Math.abs(dx) > 46 && artView) {
      const n = artView.imgs.length;
      artView.idx = (artView.idx + (dx < 0 ? 1 : -1) + n) % n;
      selectionTick();
      renderArt();
    }
  }, { passive: true });
}

/* ————————————————— player ————————————————— */
let player = null;
function playerTitle() {
  if (!player) return '';
  const g = player.g;
  const part = resolvePart(g, player.partId) || g.rep;
  const sd = seasonDisplay(g, { id: player.partId, title: part.title });
  return `${sd.name}${sd.season ? ` · S${sd.season}` : ''} · E${player.n}`;
}
function savePlayPos(final = false) {
  if (!player) return;
  const v = $('#pv');
  if (!v || !isFinite(v.currentTime) || v.currentTime < 5) return;
  const owner = watchedOwner(player.g, player.partId);
  const pp = (owner.playPos = owner.playPos || {});
  const perShow = (pp[player.partId] = pp[player.partId] || {});
  perShow[player.n] = Math.floor(v.currentTime);
  if (!player.marked && v.duration && v.currentTime / v.duration >= 0.9) {
    player.marked = true;
    const list = (owner.watched = owner.watched || {})[player.partId] || (owner.watched[player.partId] = []);
    if (!list.includes(player.n)) { list.push(player.n); list.sort((a, b) => a - b); }
    owner.lastWatchedAt = Date.now();
  }
  pushRecord(owner);
  if (final) syncScreens();
}
async function openPlayer(partId, n) {
  const g = findGroup(route.id);
  if (!g || !state.remote) return;
  closePlayer(false);
  player = { g, partId: Number(partId), n: Number(n), hls: null, saveTimer: 0, marked: false };
  const host = $('#playerhost');
  host.innerHTML = `
  <div class="playerwrap" id="playerwrap">
    <video id="pv" controls autoplay playsinline></video>
    <div class="pl-top">
      <button class="pl-x" data-act="pl-close" aria-label="Close">${I.back}</button>
      <span class="pl-t">${esc(playerTitle())}</span>
      <button class="pl-cc" data-act="pl-cc" hidden>${I.cc}</button>
    </div>
    <div class="pl-wait" id="plwait"><span></span>Preparing stream…</div>
  </div>`;
  const v = $('#pv');
  const { addr, token } = state.remote;
  try {
    const res = await fetch(`${addr}/hikari/${token}/play/${partId}/${n}`, { signal: AbortSignal.timeout(30000) })
      .then((x) => x.json());
    if (!player || res.error) throw new Error(res?.error || 'closed');
    if (res.sub) {
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = 'English'; tr.srclang = 'en'; tr.src = addr + res.sub;
      v.appendChild(tr);
      $('.pl-cc').hidden = false;
    }
    if (res.type === 'hls') {
      player.hls = new Hls({ enableWorker: true });
      player.hls.loadSource(addr + res.url);
      player.hls.attachMedia(v);
    } else v.src = addr + res.url;
    const owner = watchedOwner(g, partId);
    const saved = owner.playPos?.[partId]?.[n] || 0;
    v.addEventListener('loadeddata', () => {
      $('#plwait')?.remove();
      if (saved > 30) v.currentTime = Math.max(0, saved - 8);
    }, { once: true });
    v.addEventListener('error', () => toast('Stream failed — is the desktop still on?', 'err'));
    v.addEventListener('ended', () => {
      savePlayPos();
      const nx = player && canPlay(player.partId, player.n + 1) ? player.n + 1 : null;
      if (nx) { toast(`Next up — E${nx}`); openPlayer(player.partId, nx); }
      else closePlayer();
    });
    player.saveTimer = setInterval(savePlayPos, 10000);
  } catch (e) {
    toast(`Couldn't start stream — ${String(e.message || e).slice(0, 80)}`, 'err');
    closePlayer();
  }
}
function closePlayer(rerender = true) {
  if (!player) return;
  clearInterval(player.saveTimer);
  savePlayPos(false);
  player.hls?.destroy();
  player = null;
  $('#playerhost').textContent = '';
  if (rerender) syncScreens();
}

/* ————————————————— ticking ————————————————— */
/* In-place: flipping a class on one row costs nothing, where a re-render of a
   24-episode list costs a layout. The patch pass will agree with us later. */
function doTick(partId, n, host) {
  const g = findGroup(route.id);
  if (!g) return;
  const owner = watchedOwner(g, partId);
  const list = (owner.watched = owner.watched || {})[partId] || (owner.watched[partId] = []);
  const i = list.indexOf(n);
  let on;
  if (i >= 0) { list.splice(i, 1); on = false; }
  else { list.push(n); list.sort((a, z) => a - z); owner.lastWatchedAt = Date.now(); on = true; }
  pushRecord(owner);
  tap(on ? 'Medium' : 'Light');
  const row = host?.closest('.epr') || host;
  if (row) {
    row.classList.toggle('seen', on);
    row.classList.remove('pop'); void row.offsetWidth; row.classList.add('pop');
  }
  const el = stack[stack.length - 1]?.el;
  const cnt = el?.querySelector('#epcount');
  if (cnt) {
    const total = cnt.textContent.split('/')[1];
    cnt.textContent = `${el.querySelectorAll('.epr.seen').length}/${total}`;
  }
}

/* ═══════════════════════════ SHELL ═══════════════════════════ */
function mountShell() {
  app.innerHTML = `
    <i id="satprobe"></i>
    <div class="stage" id="stage"><div class="scrim" id="scrim"></div></div>
    <div id="sheethost"></div>
    <div id="fmhost"></div>
    <div id="arthost"></div>
    <div id="playerhost"></div>
    <nav class="tabbar" id="tabs"></nav>`;
  updateTabs();
}

const TABS = [
  ['lib', 'Library'], ['cal', 'Airing'], ['disc', 'Discover'], ['find', 'Search'], ['set', 'Account']
];
function updateTabs() {
  const tabs = $('#tabs');
  if (!tabs) return;
  const todays = calendarItems().filter((it) => sameDay(new Date(it.at), new Date())).length;
  const active = route.name === 'show' ? 'lib' : route.name;
  patch(tabs, TABS.map(([name, label]) => `
    <button class="tab ${active === name ? 'on' : ''}" data-key="tab-${name}" data-act="tab" data-tab="${name}">
      <span class="tab-i">${I[name]}${name === 'cal' && todays ? `<i class="bdg">${todays}</i>` : ''}</span>
      <span class="tab-l">${label}</span>
    </button>`).join(''));
}

const screenFor = (r) => (r.name === 'show' ? detailScreen()
  : r.name === 'cal' ? calScreen()
  : r.name === 'disc' ? discScreen()
  : r.name === 'find' ? findScreen()
  : r.name === 'set' ? setScreen()
  : libScreen());

const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function buildScreen(r) {
  const el = document.createElement('div');
  el.className = `m-screen enter s-${r.name}`;
  el.innerHTML = screenFor(r);
  applyTint(el, r);
  bindScreen(el, r);
  /* the entry stagger is a ONE-SHOT: it belongs to a fresh navigation, never
     to a patch. Dropping the class after it plays means a realtime echo can
     never leave the grid sitting at opacity:0 — the "huge blank gap under the
     rails" was exactly that animation restarting. */
  setTimeout(() => el.classList.remove('enter'), 900);
  return el;
}

/* —— per-screen behaviour —— */
function bindScreen(el, r) {
  const measure = () => {
    /* A screen that is display:none reports every offset as 0. Recording that
       is worse than not measuring at all: _diveH:0 permanently disables the
       --dive update (it is gated on the height) and _barTop goes negative,
       which disables .stuck — so the hero stayed darkened and the status-bar
       fill never appeared. Bail and let the caller re-measure once visible. */
    if (!el.isConnected || !el.offsetHeight) return;
    const dive = el.querySelector('[data-dive]');
    const bar = el.querySelector('.libbar');
    /* env(safe-area-inset-top) can't be read off a custom property reliably,
       so a zero-width probe of exactly that height reports it instead */
    const sat = $('#satprobe')?.offsetHeight || 0;
    el._diveH = dive ? dive.offsetHeight : 0;
    /* Measure the static sentinel, never the bar itself: .libbar is sticky, so
       once it is stuck its offsetTop reports where it is PARKED (scrollTop +
       inset), not where it lives in layout. Measuring it while scrolled gave a
       _barTop of 1600 instead of 559, which then mis-computes .stuck at every
       other scroll position — the transparent strip above the status bar. */
    const anchor = el.querySelector('.bar-anchor');
    el._barTop = anchor ? anchor.offsetTop - sat : (bar && !el.scrollTop ? bar.offsetTop - sat : el._barTop ?? -1);
    el._amb = el.querySelector('.amb');
    el._dive = dive;
    el._ptr = el.querySelector('.ptr');
  };
  el._measure = measure;
  measure();
  addEventListener('resize', measure, { passive: true });

  /* Scroll-driven values go on the FEW elements that consume them, never on
     the screen root. A custom property is inherited, so changing one on the
     root invalidates style for the entire subtree every frame — with 205
     posters under it that measured p95 25ms / 6 dropped frames per scroll,
     while the much smaller detail screen held a flat 240fps. Writing to
     `.amb` and the dive element keeps the invalidation to a handful of nodes.
     `data-vars` tells the patcher to carry these across a re-render. */
  const applyScroll = (st) => {
    const dive = el._dive || (el._dive = el.querySelector('[data-dive]'));
    /* --sy is gone: the ambient is position:fixed now, so nothing needs
       re-positioning per frame */
    if (dive && el._diveH) {
      const p = Math.min(1, st / el._diveH);
      const pv = p.toFixed(3);
      dive.style.setProperty('--par', `${Math.min(st, el._diveH)}px`);
      dive.style.setProperty('--dive', pv);
    }
    if (el._barTop >= 0) el.classList.toggle('stuck', st >= el._barTop - 1);
    if (el._diveH) el.classList.toggle('past-hero', st > el._diveH);
  };
  /* Recompute from the CURRENT scroll offset. Everything above used to run
     only on a scroll event, so a screen restored from the tab cache kept
     whatever --dive / .stuck / .past-hero it had when you left it — a darkened
     hero, a missing status-bar fill — until you happened to scroll, at which
     point it all snapped at once. That snap was the flicker. */
  el._applyScroll = () => applyScroll(el.scrollTop);
  onScrollFrame(el, (st) => {
    if (stack[stack.length - 1]?.el !== el) return;
    applyScroll(st);
  });

  /* hero carousel dots */
  el.addEventListener('scroll', (e) => {
    const t = e.target;
    if (!t.classList?.contains('herotrack')) return;
    const i = Math.round(t.scrollLeft / (t.clientWidth || 1));
    el.querySelectorAll('.herodots i').forEach((d, k) => d.classList.toggle('on', k === i));
  }, { passive: true, capture: true });

  /* live inputs — the field is never re-created, so the keyboard stays up */
  const q0 = el.querySelector('#q');
  if (q0) {
    q0.addEventListener('input', () => { q = q0.value; schedule(syncScreens); });
    q0.addEventListener('focus', () => scrollToBar(el));
  }
  const f0 = el.querySelector('#fq');
  if (f0) {
    f0.addEventListener('input', () => {
      findQ = f0.value;
      clearTimeout(findTimer);
      findTimer = setTimeout(runFind, 400);
      schedule(syncScreens);          // repaint the clear button, nothing else
    });
  }

  if (r.name === 'lib' || r.name === 'cal') bindPullToRefresh(el);
  if (r.name === 'show') bindEdgeSwipe(el);
}

function scrollToBar(el) {
  const bar = el.querySelector('.libbar');
  if (!bar) return;
  const top = bar.offsetTop;
  if (el.scrollTop >= top - 2) return;
  el.scrollTo({ top, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

/* Pull down past the top to force a sync. */
function bindPullToRefresh(el) {
  let sy = 0, active = false, armed = false;
  el.addEventListener('touchstart', (e) => {
    if (el.scrollTop > 0 || e.touches.length > 1) { active = false; return; }
    sy = e.touches[0].clientY; active = true; armed = false;
    el.classList.remove('ptr-settle');
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!active) return;
    const dy = e.touches[0].clientY - sy;
    const ptr = el._ptr || (el._ptr = el.querySelector('.ptr'));
    if (dy <= 0) { ptr?.style.setProperty('--ptr', '0'); return; }
    const d = Math.min(92, dy * 0.5);
    ptr?.style.setProperty('--ptr', d.toFixed(1));
    if (d >= 60 && !armed) { armed = true; selectionTick(); }
    if (d < 60) armed = false;
  }, { passive: true });
  el.addEventListener('touchend', async () => {
    if (!active) return;
    active = false;
    el.classList.add('ptr-settle');
    const ptr = el._ptr || (el._ptr = el.querySelector('.ptr'));
    if (!armed) { ptr?.style.setProperty('--ptr', '0'); return; }
    el.classList.add('refreshing');
    ptr?.style.setProperty('--ptr', '54');
    try { const n = await pull(); toast(n ? `Synced — ${n} update${n === 1 ? '' : 's'}` : 'Up to date'); }
    finally {
      el.classList.remove('refreshing');
      ptr?.style.setProperty('--ptr', '0');
    }
  });
}

/* Edge-swipe back — the screen follows the finger, and the screen underneath
   un-dims in step so the gesture feels attached to both. */
function bindEdgeSwipe(el) {
  let sx = 0, sy = 0, dx = 0, dragging = false;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (t.clientX > 28 || e.touches.length > 1) return;
    sx = t.clientX; sy = t.clientY; dx = 0; dragging = true;
    el.classList.add('dragging');
    stack[stack.length - 2]?.el.classList.add('nofade');   // follow the finger, don't ease
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const t = e.touches[0];
    dx = Math.max(0, t.clientX - sx);
    if (Math.abs(t.clientY - sy) > 70 && dx < 40) {   // it's a scroll, not a swipe
      dragging = false;
      el.classList.remove('dragging');
      stack[stack.length - 2]?.el.classList.remove('nofade');
      el.style.transform = '';
      setUnder(1);
      return;
    }
    el.style.transform = `translate3d(${dx}px,0,0)`;
    setUnder(1 - dx / innerWidth);
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    stack[stack.length - 2]?.el.classList.remove('nofade');
    el.style.transform = '';
    if (dx > innerWidth * 0.3) { tap(); navigate(null, 'pop'); }
    else setUnder(1);
  });
  const setUnder = (k) => {
    const under = stack[stack.length - 2]?.el;
    if (under) under.style.setProperty('--under', k.toFixed(3));
  };
}

/* ═══════════════════════════ NAVIGATION ═══════════════════════════ */
/* Tab screens are built once and kept. Coming back to the Library re-shows
   the same nodes at the same scroll offset — no rebuild, no re-layout of 200
   posters, no image re-decode, nothing to animate back in. */
/* the tab bar's live blur is dropped while anything is sliding */
let animTimer = 0;
function markAnimating() {
  const stage = $('#stage');
  if (!stage) return;
  stage.classList.add('animating');
  clearTimeout(animTimer);
  animTimer = setTimeout(() => stage.classList.remove('animating'), 560);
}

const tabScreens = new Map();     // name -> el
const tabScroll = new Map();      // name -> scrollTop
const tabDirty = new Set();

function navigate(r, mode = 'tab') {
  const stage = $('#stage');
  if (!stage) return;
  /* after the route settles, ask about the desktop only if the screen we are
     landing on would actually show the answer */
  setTimeout(() => { probeIfRelevant(); prefetchForRoute(); }, 0);

  if (mode === 'pop') {
    if (stack.length < 2) return;
    deferHeavy = false;
    const gone = stack.pop();
    const prev = stack[stack.length - 1];
    route = prev.route;
    setChrome(chromeFor(prev.route));
    /* --under is the displacement amount: 1 = pushed back, 0 = home. Animate
       it to 0 and only drop the class once the transition has finished, or
       the screen underneath would snap instead of easing. */
    markAnimating();
    $('#scrim')?.classList.remove('on');
    prev.el.style.setProperty('--under', '0');
    setTimeout(() => {
      if (stack[stack.length - 1]?.el === prev.el) {
        prev.el.classList.remove('under');
        prev.el.style.removeProperty('--under');
      }
    }, 430);
    gone.el.classList.remove('on');
    gone.el.classList.add('leaving');
    setTimeout(() => gone.el.remove(), 430);
    syncScreens();
    updateTabs();
    return;
  }

  if (mode === 'push') {
    const top = stack[stack.length - 1];
    route = r;
    synClamped = true;
    setChrome(chromeFor(r));
    deferHeavy = true;
    const el = buildScreen(r);
    el.classList.add('push');
    stage.appendChild(el);
    stack.push({ route: r, el });
    if (top) {
      top.el.classList.add('under');
      top.el.style.setProperty('--under', '0');
    }
    markAnimating();
    nextTick(el, () => {
      el.classList.add('on');
      $('#scrim')?.classList.add('on');
      if (top) top.el.style.setProperty('--under', '1');
      el._measure?.();
      el._applyScroll?.();
    });
    /* fill in the expensive part once the screen has finished moving */
    setTimeout(() => {
      if (!deferHeavy) return;
      deferHeavy = false;
      if (route.name === 'show') { syncScreens(); el._measure?.(); }
    }, 460);
    updateTabs();
    return;
  }

  /* —— tab —— */
  const name = r.name;
  const prevBase = stack[0];
  if (prevBase) {
    tabScroll.set(prevBase.route.name, prevBase.el.scrollTop);
    prevBase.el.classList.remove('under');
    prevBase.el.style.removeProperty('--under');
  }
  for (const s of stack.slice(1)) s.el.remove();     // drop any pushed detail

  route = r;
  setChrome(null);

  let el = tabScreens.get(name);
  if (!el) {
    el = buildScreen(r);
    tabScreens.set(name, el);
    stage.appendChild(el);
  } else {
    /* visible FIRST — measuring a display:none screen yields zeros */
    el.classList.remove('hidden', 'fadeout');
    if (!el.isConnected) stage.appendChild(el);
    if (tabDirty.has(name)) { patch(el, screenFor(r)); tabDirty.delete(name); }
    el.scrollTop = tabScroll.get(name) || 0;
  }
  stack = [{ route: r, el }];
  /* after stack is set, so the handler's "am I on top?" guard passes */
  el._measure?.();
  el._applyScroll?.();

  /* Instant, like a native tab bar. The old cross-fade animated opacity on a
     whole screen — the same "promote and re-blend an enormous layer" cost that
     made the push expensive, for a transition users read as instant anyway. */
  el.classList.remove('fade', 'fadeout', 'hidden');
  el.classList.add('on');
  $('#scrim')?.classList.remove('on');
  if (prevBase && prevBase.el !== el) {
    prevBase.el.classList.add('hidden');
    prevBase.el.classList.remove('fade', 'fadeout', 'on');
  }
  updateTabs();
}

/* Patch every live screen; mark the parked tabs for a patch on their way back
   in. Coalesced to one frame so a burst of realtime rows costs one pass. */
/* tint for the screens that don't carry an .amb element */
function applyTint(el, r) {
  if (r.name === 'show') return;
  let rec = null;
  if (r.name === 'lib') {
    const groups = groupsSorted();
    const cw = groups.map((g) => ({ g, at: lastWatched(g) })).filter((x) => x.at)
      .sort((a, b) => b.at - a.at)[0];
    rec = (cw?.g || groups[0])?.rep;
  } else if (r.name === 'disc') rec = discPool?.[0] ? { coverColor: discPool[0].color } : null;
  const c = rec?.coverColor;
  if (c) el.style.setProperty('--tint', c);
  else el.style.removeProperty('--tint');
}

function syncScreens() {
  if (!state.user || !stack.length) return;
  for (const s of stack) {
    patch(s.el, screenFor(s.route));
    applyTint(s.el, s.route);
    s.el._measure?.();
    s.el._applyScroll?.();
    s.el._measure?.();
  }
  const live = new Set(stack.map((s) => s.route.name));
  for (const name of tabScreens.keys()) if (!live.has(name)) tabDirty.add(name);
  updateTabs();
}
const syncSoon = () => schedule(syncScreens);

/* Relation-type + English-title migration (frv 4): one show at a time at
   background priority, stopping when there is nothing left. Device only —
   the browser preview cannot reach the CORS-blocked hosts anyway. */
let migrating = false;
async function migrateFranchises() {
  if (migrating || !isNative()) return;
  const next = state.library.find((r) => (r.franchise || []).length && !hasRelations(r));
  if (!next) return;
  migrating = true;
  try {
    next.franchise = await fetchFranchise(next.id);
    next.frv = FRV_RELATIONS;
    pushRecord(next);
    invalidateGroups();
    syncSoon();
  } catch { /* move on; a failure here must never block the app */ }
  finally {
    migrating = false;
    setTimeout(migrateFranchises, 2500);
  }
}
setTimeout(migrateFranchises, 60000);

state.onChange = () => {
  invalidateGroups();
  syncSoon();
  bootEnrich();
  backfillTags();
  /* deliberately NOT probing the desktop here — a data change says nothing
     about the LAN, and doing it per-record made the app crawl */
};

/* ═══════════════════════════ SHEETS + MODALS ═══════════════════════════ */
function fmodalMarkup() {
  const { genres, tags } = filterIndexes();
  const matches = viewFilter(groupsSorted()).length;
  const chip = (name, n, on, act) => `
    <button class="chip ${on ? 'on' : ''}" data-key="fc-${esc(name)}" data-act="${act}" data-g="${esc(name)}">
      ${esc(name)}<i>${n}</i></button>`;
  return `
  <div class="fmodal" id="fmodal">
    <div class="fm-head">
      <b>Filters</b>
      <button class="fm-x" data-act="fm-close" aria-label="Close">${I.x}</button>
    </div>
    <div class="fm-body">
      <p class="mini-label">Genres</p>
      <div class="fm-grid">${genres.map(([g, n]) => chip(g, n, libGenres.has(g), 'g-toggle')).join('')}</div>
      <p class="mini-label">Tags</p>
      <div class="fm-grid">${tags.map(([t, n]) => chip(t, n, libTags.has(t), 't-toggle')).join('')}</div>
      <div class="endpad"></div>
    </div>
    <div class="fm-foot">
      <button class="btn-line" data-act="fm-clear" ${libGenres.size + libTags.size ? '' : 'disabled'}>Clear</button>
      <button class="btn-solid" data-act="fm-close">Show ${matches} show${matches === 1 ? '' : 's'}</button>
    </div>
  </div>`;
}
function fmCountSync() {
  const btn = $('#fmodal .btn-solid');
  if (btn) {
    const n = viewFilter(groupsSorted()).length;
    btn.textContent = `Show ${n} show${n === 1 ? '' : 's'}`;
  }
  const clr = $('#fmodal [data-act="fm-clear"]');
  if (clr) clr.disabled = !(libGenres.size + libTags.size);
}
function renderFModal(animateIn = false) {
  const host = $('#fmhost');
  if (!host) return;
  if (!filterModal) {
    const m = $('#fmodal');
    if (m) { m.classList.remove('on'); setTimeout(() => { host.textContent = ''; }, 260); }
    return;
  }
  host.innerHTML = fmodalMarkup();
  const m = $('#fmodal');
  if (animateIn) nextTick(m, () => m.classList.add('on'));
  else m.classList.add('on');
}

function sheetMarkup() {
  const wrap = (title, body, cls = '') => `
  <div class="sheetwrap" id="sheetwrap" data-act="sheet-close">
    <div class="sheet ${cls}" data-stop="1">
      <div class="grab"></div>
      ${title ? `<p class="sh-title">${title}</p>` : ''}
      ${body}
      <div class="endpad"></div>
    </div>
  </div>`;

  if (sheet?.kind === 'family') {
    const rec = state.library.find((r) => r.id === sheet.id);
    const shows = rec ? franchiseShows(rec) : [];
    const ownedShowIds = new Set(state.library.map((r) => showIdOf(r)).filter((x) => x != null));
    const ownedRecordIds = new Set(state.library.map((r) => r.id));
    return wrap('In this franchise', shows.map((sh) => {
      const e = sh.rep;
      const owned = ownedShowIds.has(sh.primaryId) || sh.entries.some((x) => ownedRecordIds.has(x.id));
      const tv = sh.entries.filter((x) => x.format === 'TV' || x.format === 'TV_SHORT').length;
      const meta = [e.year, e.format, tv > 1 ? `${tv} seasons` : (e.episodes ? `${e.episodes} EP` : '')]
        .filter(Boolean).join(' · ');
      return `
      <button class="ss-row ${owned ? 'on' : ''}" data-act="${owned ? 'fam-open' : 'fam-add'}" data-id="${e.id}">
        <img class="ss-cov" src="${esc(e.cover || '')}" alt="" loading="lazy">
        <span class="sst"><b>${esc(e.title || '')}</b><small>${esc(meta)}</small></span>
        <span class="ok">${owned ? I.check : I.plus}</span>
      </button>`;
    }).join(''), 'tall');
  }

  if (sheet?.kind === 'keys') return keysSheetHTML(wrap);

  if (sheet?.kind === 'seasons') {
    const g = findGroup(route.id);
    if (!g) return '';
    const seasons = mobileSeasons(g);
    const multi = seasons.filter((se) => se.num).length > 1;
    const all = viewables(g);
    const cur = all.find((se) => se.records.some((r) => r.id === route.season)) || seasons[0];
    return wrap('Seasons', seasons.map((se) => {
      const eps = se.records.reduce((a, p) => a + epCount(p), 0);
      const seen = se.records.reduce((a, p) => a + [...watchedSet(g, p.id)]
        .filter((n) => n <= (epCount(p) || Infinity)).length, 0);
      const dub = se.records.some((p) => !p.stub && recHasDub(p));
      const done = eps > 0 && seen >= eps;
      return `
      <button class="ss-row ${se === cur ? 'on' : ''}" data-act="season" data-id="${se.parts[0].id}">
        <span class="sst">
          <b>${se.num && multi ? `Season ${se.num}` : esc((se.records[0].title || '').slice(0, 34))}</b>
          <small>${eps ? `${seen}/${eps} episodes` : 'No episode list'}${dub ? ' · <span class="db">DUB</span>' : ''}</small>
          ${eps ? `<span class="ss-bar"><i style="width:${Math.round((seen / eps) * 100)}%"></i></span>` : ''}
        </span>
        ${se === cur ? `<span class="ok">${I.check}</span>` : done ? `<span class="ok dim">${I.checkFill}</span>` : ''}
      </button>`;
    }).join(''), 'tall');
  }

  if (sheet?.kind === 'manage') {
    const g = findGroup(route.id);
    if (!g) return '';
    const fav = g.members.some((m) => m.favourite);
    const trailer = g.rep.trailer?.id;
    return wrap(esc(g.rep.title), `
      <button class="ss-row" data-act="fav">
        <span class="mmi">${fav ? I.heartFill : I.heart}</span>
        <span class="sst"><b>${fav ? 'Remove from favourites' : 'Add to favourites'}</b></span>
      </button>
      ${trailer ? `<a class="ss-row" href="https://www.youtube.com/watch?v=${esc(trailer)}" target="_blank" rel="noreferrer">
        <span class="mmi">${I.play}</span><span class="sst"><b>Watch trailer</b></span>
        <span class="ok">${I.arrowOut}</span></a>` : ''}
      <a class="ss-row" href="${esc(g.rep.siteUrl || `https://anilist.co/anime/${g.rep.id}`)}" target="_blank" rel="noreferrer">
        <span class="mmi">${I.find}</span><span class="sst"><b>Open on AniList</b></span>
        <span class="ok">${I.arrowOut}</span></a>
      <button class="ss-row danger" data-act="remove-show">
        <span class="mmi">${I.trash}</span><span class="sst"><b>Remove from shelf</b></span>
      </button>`);
  }

  if (sheet?.kind === 'identify') {
    return wrap('Identify from', `
      <button class="ss-row" data-act="id-pick">
        <span class="mmi">${I.images}</span>
        <span class="sst"><b>Choose a screenshot</b><small>From your photos</small></span>
      </button>
      <button class="ss-row" data-act="id-camera">
        <span class="mmi">${I.tv}</span>
        <span class="sst"><b>Take a photo</b><small>Point it at a TV or another screen</small></span>
      </button>`);
  }

  if (sheet?.kind === 'views') {
    const gs = allGroups();
    const counts = {
      all: gs.length,
      unwatched: gs.filter((g) => !groupDone(g) && groupProgress(g).total > 0).length,
      dub: gs.filter(groupDub).length,
      fav: gs.filter(groupFav).length
    };
    return wrap('Show', `
      ${VIEWS.map(([k, l]) => `
      <button class="ss-row ${libView === k ? 'on' : ''}" data-act="view-pick" data-view="${k}">
        <span class="sst"><b>${l}</b><small>${counts[k]} show${counts[k] === 1 ? '' : 's'}</small></span>
        ${libView === k ? `<span class="ok">${I.check}</span>` : ''}
      </button>`).join('')}
      <p class="sh-title">Sort by</p>
      ${SORTS.map(([k, l]) => `
      <button class="ss-row ${libSort === k ? 'on' : ''}" data-act="sort-pick" data-sort="${k}">
        <span class="sst"><b>${l}</b></span>
        ${libSort === k ? `<span class="ok">${I.check}</span>` : ''}
      </button>`).join('')}`, 'tall');
  }

  const r = sheet?.rec;
  if (!r && sheet?.error) {
    return wrap('', `
      <div class="sh-err">
        <span class="sh-err-i">${I.warning}</span>
        <b>Couldn’t load this show</b>
        <p>${esc(sheet.error)}</p>
        <button class="btn-solid" data-act="sheet-retry" data-id="${sheet.id}">Try again</button>
        <button class="btn-line auto" data-act="sheet-close">Close</button>
      </div>`, 'preview');
  }
  return wrap('', !r ? '<div class="sh-load"><i></i></div>' : `
    <div class="sh-hero">${r.banner ? `<img src="${esc(r.banner)}" alt="">` : ''}</div>
    <div class="sh-body">
      <img class="sh-poster" src="${esc(r.cover)}" alt="">
      <div class="sh-t">
        <b>${esc(r.title)}</b>
        <small>${[r.year, r.format, r.episodes ? `${r.episodes} EP` : null, r.score ? `★ ${(r.score / 10).toFixed(1)}` : null]
          .filter(Boolean).map(esc).join('<i class="dot"></i>')}
          ${(r.dubLanguages || []).includes('English') ? '<span class="rdub">DUB</span>' : ''}</small>
        <small class="gl">${(r.genres || []).slice(0, 4).map(esc).join(' · ')}</small>
      </div>
    </div>
    <p class="sh-syn">${esc((cleanSynopsis(r.description) || '').slice(0, 420))}…</p>
    <div class="sh-btns sh-adds">
      <button class="btn-solid" data-act="sheet-add" data-id="${r.id}" ${sheet.busy ? 'disabled' : ''}>
        ${sheet.busy ? 'Adding…' : `${I.plus}Add show`}</button>
      <button class="btn-line" data-act="sheet-add-fr" data-id="${r.id}" ${sheet.busy ? 'disabled' : ''}
              title="Add the whole franchise, starting at season 1">Franchise</button>
      <a class="btn-line" href="${esc(r.siteUrl || `https://anilist.co/anime/${r.id}`)}" target="_blank" rel="noreferrer">${I.arrowOut}</a>
    </div>`, 'preview');
}
function renderSheet(animateIn = false) {
  const host = $('#sheethost');
  if (!host) return;
  if (!sheet) {
    const w = $('#sheetwrap');
    if (w) { w.classList.remove('on'); setTimeout(() => { host.textContent = ''; }, 400); }
    return;
  }
  /* `on` is added at runtime, so it is NOT in the markup string — which means
     any patch that replaces the wrap silently drops it. Re-assert it against
     the CURRENT element every time. */
  if (!animateIn && $('#sheetwrap')) {
    patch(host, sheetMarkup());
    $('#sheetwrap')?.classList.add('on');
    return;
  }
  host.innerHTML = sheetMarkup();
  const w = $('#sheetwrap');
  if (!w) return;
  /* Re-query inside the callback rather than closing over `w`. If the record
     resolves before this fires, the patch has already swapped the node and the
     captured reference is detached — `on` would land on a dead element while
     the live wrap stayed invisible, covering the screen and eating every tap.
     That is the "sheet slid back and now nothing responds" bug. */
  if (animateIn) nextTick(w, () => $('#sheetwrap')?.classList.add('on'));
  else w.classList.add('on');
  const sh = w?.querySelector('.sheet');
  if (!sh) return;
  let sy = 0, dy = 0, dragging = false;
  sh.addEventListener('touchstart', (e) => {
    if (sh.scrollTop > 2) return;
    sy = e.touches[0].clientY; dy = 0; dragging = true;
    sh.style.transition = 'none';
  }, { passive: true });
  sh.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - sy);
    sh.style.transform = `translate3d(0,${dy}px,0)`;
    w.style.setProperty('--sheet-p', String(Math.max(0, 1 - dy / 320)));
  }, { passive: true });
  sh.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    sh.style.transition = '';
    sh.style.transform = '';
    w.style.removeProperty('--sheet-p');
    if (dy > 110) { tap(); closeSheet(); }
  });
}
/* A failed lookup used to delete the sheet outright, which read as "the popup
   flashed and vanished" and threw away the one thing worth seeing — why it
   failed. Keep the sheet up, say what went wrong, offer another go. */
async function openPreview(id, animateIn = true) {
  sheet = { kind: 'preview', id, rec: null, busy: false, error: null };
  renderSheet(animateIn);
  try {
    const rec = await buildRecord(id);
    if (sheet?.id === id) { sheet.rec = rec; sheet.error = null; renderSheet(); }
  } catch (e) {
    if (sheet?.id !== id) return;            // the user moved on
    sheet.error = e.message || String(e);
    renderSheet();
  }
}
function closeSheet() { sheet = null; renderSheet(); }

/* ————————————————— auth ————————————————— */
function authHTML() {
  return `
  <div class="m-screen on"><div class="auth">
    <p class="mark">HIKARI<i>·</i>ヒカリ</p>
    <h1>Your shelf,<br>in your pocket.</h1>
    <p class="lede">Sign in with your Hikari account — the one from the desktop app's Sync tab.</p>
    <label class="f-label" for="aEmail">Email</label>
    <input class="f-input" id="aEmail" type="email" autocomplete="username" spellcheck="false" placeholder="you@example.com">
    <label class="f-label" for="aPass">Password</label>
    <input class="f-input" id="aPass" type="password" autocomplete="current-password" placeholder="••••••••">
    <button class="btn-solid" data-act="signin">Sign in</button>
    <button class="btn-line" data-act="signup">Create account</button>
    <p class="hint">Library, watched history and dub schedules sync live with the desktop app.
      Local files stream from the desktop when it's on the same network.</p>
  </div></div>`;
}

/* ═══════════════════════════ EVENTS ═══════════════════════════ */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'sheet-close' && e.target.closest('[data-stop]')) return;

  switch (b.dataset.act) {
    case 'tab': {
      closeSheet();
      if (route.name === b.dataset.tab) {
        stack[stack.length - 1]?.el.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
        break;
      }
      if (route.name === 'show' && b.dataset.tab === 'lib') { navigate(null, 'pop'); break; }
      selectionTick();
      navigate({ name: b.dataset.tab }, 'tab');
      break;
    }
    case 'show': {
      closeSheet();
      tap();
      navigate({ name: 'show', id: Number(b.dataset.id) }, 'push');
      break;
    }
    case 'back': tap(); navigate(null, 'pop'); break;
    case 'seasons': sheet = { kind: 'seasons' }; renderSheet(true); break;
    case 'season':
      route.season = Number(b.dataset.id);
      closeSheet();
      selectionTick();
      syncScreens();
      break;
    case 'more': synClamped = !synClamped; syncScreens(); break;
    case 'tick': doTick(Number(b.dataset.part), Number(b.dataset.n), b); break;
    case 'ep-tap': {
      const partId = Number(b.dataset.part);
      const n = Number(b.dataset.n);
      if (canPlay(partId, n)) { tap('Medium'); openPlayer(partId, n); }
      else doTick(partId, n, b);
      break;
    }
    case 'pl-close': closePlayer(); break;
    case 'pl-cc': {
      const tr = $('#pv')?.textTracks?.[0];
      if (tr) { tr.mode = tr.mode === 'showing' ? 'hidden' : 'showing'; b.classList.toggle('on', tr.mode === 'showing'); }
      break;
    }
    case 'art-open': openArt(); break;
    case 'art-close': artView = null; renderArt(); break;
    case 'art-nav': {
      if (!artView) break;
      const n = artView.imgs.length;
      artView.idx = (artView.idx + Number(b.dataset.dir) + n) % n;
      selectionTick();
      renderArt();
      break;
    }
    case 'bio-unlock': bioVerify(); break;
    case 'bio-toggle': {
      if (bioEnabled()) { localStorage.removeItem('hikariBioLock'); toast('Fingerprint lock off'); }
      else {
        try {
          bioChecking = true;
          await bio.authenticate({
            reason: 'Confirm fingerprint', androidTitle: 'Confirm fingerprint',
            androidConfirmationRequired: false, allowDeviceCredential: true
          });
          localStorage.setItem('hikariBioLock', '1');
          toast('Fingerprint lock on — the app locks when you leave it');
        } catch (err) {
          toast(`Not confirmed — ${err?.message || err?.code || 'cancelled'}`, 'err');
        } finally { setTimeout(() => { bioChecking = false; }, 800); }
      }
      syncScreens();
      break;
    }
    case 'fav': {
      const g = findGroup(route.id);
      if (!g) break;
      g.rep.favourite = !g.members.some((m) => m.favourite);
      for (const m of g.members) if (m !== g.rep) m.favourite = false;
      pushRecord(g.rep);
      buzz();
      syncScreens();
      if (sheet?.kind === 'manage') renderSheet();
      break;
    }
    case 'remove-show': {
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.querySelector('.sst b').textContent = 'Tap again — watched history goes too';
        setTimeout(() => {
          b.classList.remove('armed');
          const t = b.querySelector('.sst b');
          if (t) t.textContent = 'Remove from shelf';
        }, 3500);
        break;
      }
      const g = findGroup(route.id);
      if (!g) break;
      try {
        const title = g.rep.title;
        await removeShow(g.members.map((m) => m.id));
        closeSheet();
        toast(`${title} removed`);
        navigate(null, 'pop');
      } catch (err) { toast('Remove failed — ' + (err.message || err), 'err'); }
      break;
    }
    case 'dub-adj': {
      const g = findGroup(route.id);
      mutatePart(g, Number(b.dataset.part), (target) => {
        const di = dubInfo(target) || { upTo: 0 };
        target.dubOverride = { ep: Math.max(0, di.upTo + Number(b.dataset.dir)), at: Date.now() };
      });
      selectionTick();
      syncScreens();
      break;
    }
    case 'views': sheet = { kind: 'views' }; renderSheet(true); break;
    case 'more-menu': sheet = { kind: 'manage' }; renderSheet(true); break;
    case 'view-pick':
      libView = b.dataset.view;
      closeSheet();
      syncScreens();
      scrollToBar(stack[0].el);
      break;
    case 'sort-pick':
      libSort = b.dataset.sort;
      closeSheet();
      syncScreens();
      break;
    case 'q-clear': {
      q = '';
      syncScreens();
      stack[0]?.el.querySelector('#q')?.focus();
      break;
    }
    case 'fq-clear': {
      findQ = ''; findResults = null;
      syncScreens();
      stack[0]?.el.querySelector('#fq')?.focus();
      break;
    }
    case 'clear-all':
      q = ''; libView = 'all'; libGenres.clear(); libTags.clear();
      syncScreens();
      break;
    case 'filters': filterModal = true; renderFModal(true); break;
    case 'fm-close': filterModal = false; renderFModal(); syncScreens(); break;
    case 'fm-clear': libGenres.clear(); libTags.clear(); renderFModal(); syncScreens(); break;
    /* chip toggles patch in place — re-rendering 190 chips per tap is the lag */
    case 'g-toggle': case 't-toggle': {
      const set = b.dataset.act === 'g-toggle' ? libGenres : libTags;
      const c = b.dataset.g;
      set.has(c) ? set.delete(c) : set.add(c);
      b.classList.toggle('on', set.has(c));
      selectionTick();
      fmCountSync();
      syncSoon();
      break;
    }
    case 'mtag-jump':
      libTags = new Set([b.dataset.g]);
      libGenres.clear();
      if (stack.length > 1) navigate(null, 'pop');
      else syncScreens();
      break;
    case 'cal-seg':
      calSeg = b.dataset.seg;
      selectionTick();
      syncScreens();
      if (calSeg === 'announced') hydrateAnnouncements();
      break;
    case 'ann-add':
    case 'fam-add': {
      tap();
      const id = Number(b.dataset.id);
      b.classList.add('busy');
      try {
        const rec = await buildRecord(id);
        try { const fr = await fetchFranchise(id); rec.franchise = fr; rec.frv = FRV_RELATIONS; } catch { /* lite is fine */ }
        await addShow(rec);
        buzz();
        toast(`${rec.title} added`);
        closeSheet();
        enrichAdded(rec.id);
      } catch (err) {
        b.classList.remove('busy');
        toast('Could not add — ' + (err.message || err), 'err');
      }
      break;
    }
    case 'fam-open': {
      const g = findGroup(Number(b.dataset.id));
      closeSheet();
      if (g) navigate({ name: 'show', id: g.rep.id }, 'push');
      break;
    }
    case 'family': {
      tap();
      sheet = { kind: 'family', id: Number(b.dataset.id) };
      renderSheet(true);
      break;
    }
    case 'remote-retry':
      tap();
      probeRemote(true);
      break;
    case 'diag-copy': {
      const b = alBudget();
      const text = [
        `Hikari mobile ${__APP_VERSION__}${isNative() ? ' (device)' : ' (browser)'}`,
        `library=${state.library.length} lastSync=${state.lastSync || 0}`,
        `desktop=${state.remote ? (remoteOk ? `ok ${remoteAddr}` : `down ${remoteWhy}`) : 'none'}`,
        `anilist=${b.remaining ?? '?'} left, ${b.queued} queued`,
        ...lastErrors.map((e) => `${new Date(e.at).toISOString()} ${e.msg}`)
      ].join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('Diagnostics copied');
      } catch { toast('Could not copy — screenshot this panel instead', 'err'); }
      break;
    }
    case 'id-source':
      tap();
      sheet = { kind: 'identify' };
      renderSheet(true);
      /* so the figure is current before a search is spent */
      traceQuota().then((q) => { if (q && idState) { idState.quota = q; syncScreens(); } });
      break;
    case 'id-pick': closeSheet(); pickIdentifyImage(false); break;
    case 'id-camera': closeSheet(); pickIdentifyImage(true); break;
    case 'id-clear':
      if (idState?.preview) URL.revokeObjectURL(idState.preview);
      idState = null;
      syncScreens();
      break;
    case 'preview': tap(); openPreview(Number(b.dataset.id)); break;
    case 'open-owned': {
      const g = findGroup(Number(b.dataset.id));
      if (g) { closeSheet(); navigate({ name: 'show', id: g.rep.id }, 'push'); }
      break;
    }
    case 'sheet-close': closeSheet(); break;
    case 'sheet-retry': tap(); openPreview(Number(b.dataset.id), false); break;
    case 'keys-open':
      tap();
      /* snapshot what the fields are populated FROM: on save we send only
         what actually changed, so an untouched blank field can never delete a
         key the desktop set a moment ago */
      sheet = { kind: 'keys', busy: false, initial: { ...state.keys } };
      renderSheet(true);
      break;
    case 'keys-save': {
      /* read the live inputs — they are [data-keep] so a re-render never
         stomps what is being typed — and send only the ones that moved */
      const initial = sheet.initial || {};
      const next = {};
      for (const el of document.querySelectorAll('[data-key-field]')) {
        const k = el.dataset.keyField;
        if (el.value.trim() !== String(initial[k] || '').trim()) next[k] = el.value;
      }
      if (!Object.keys(next).length) { closeSheet(); break; }
      sheet.busy = true; renderSheet();
      try {
        await saveKeys(next);
        toast('Keys saved to your account');
        closeSheet();
      } catch (err) {
        if (sheet) { sheet.busy = false; renderSheet(); }
        toast('Could not save — ' + (err.message || err), 'err');
      }
      break;
    }
    case 'sheet-add-fr':
    case 'sheet-add': {
      if (!sheet?.rec) break;
      sheet.busy = true;
      renderSheet();
      try {
        /* Land on the show, not on whichever part came out of search. The
           franchise walk decides that, so it happens before the add rather
           than in the background; everything else stays in the watch order. */
        let rec = sheet.rec;
        let swapped = false;
        const wholeFranchise = b.dataset.act === 'sheet-add-fr';
        try {
          const fr = await fetchFranchise(rec.id);
          /* Resolve to season 1 only when the franchise was asked for —
             sometimes you really do want just this entry. */
          const primary = wholeFranchise ? franchisePrimary(fr) : null;
          if (primary && primary.id !== rec.id) {
            const owned = state.library.find((r) => r.id === primary.id);
            if (owned) {
              closeSheet();
              navigate({ name: 'show', id: owned.id }, 'push');
              toast(`${owned.title} is already on your shelf`);
              break;
            }
            rec = await buildRecord(primary.id);
            swapped = true;
          }
          rec.franchise = fr;
          rec.frv = FRV_RELATIONS;
        } catch { /* no franchise: add exactly what was picked */ }
        await addShow(rec);
        buzz();
        toast(swapped
          ? `${rec.title} added — every season is in its watch order`
          : `${rec.title} added to your shelf`);
        closeSheet();
        navigate({ name: 'show', id: rec.id }, 'push');
        enrichAdded(rec.id);
      } catch (err) {
        if (sheet) { sheet.busy = false; renderSheet(); }
        toast('Add failed — ' + (err.message || err), 'err');
      }
      break;
    }
    case 'disc-genre': {
      const ge = b.dataset.g;
      discGenres.has(ge) ? discGenres.delete(ge) : discGenres.add(ge);
      selectionTick();
      syncScreens();
      break;
    }
    case 'disc-clear': discGenres.clear(); syncScreens(); break;
    case 'disc-regen':
      discPool = null; discGenres.clear();
      buildDiscover(true);
      if (route.name !== 'disc') { navigate({ name: 'disc' }, 'tab'); break; }
      syncScreens();
      break;
    case 'syncnow': {
      const n = await pull();
      toast(n ? `Synced — ${n} update${n === 1 ? '' : 's'}` : 'Up to date');
      syncScreens();
      break;
    }
    case 'signout': closeSheet(); await supa.auth.signOut().catch(() => {}); break;
    case 'signin': case 'signup': {
      const email = $('#aEmail').value.trim();
      const pass = $('#aPass').value;
      if (!email || !pass) return toast('Enter email and password', 'err');
      b.disabled = true;
      try {
        if (b.dataset.act === 'signup') {
          const { data, error } = await supa.auth.signUp({ email, password: pass });
          if (error) throw error;
          if (!data.session) {
            const { error: e2 } = await supa.auth.signInWithPassword({ email, password: pass });
            if (e2) throw e2;
          }
        } else {
          const { error } = await supa.auth.signInWithPassword({ email, password: pass });
          if (error) throw error;
        }
      } catch (err) { toast(String(err.message || err), 'err'); }
      b.disabled = false;
      break;
    }
  }
});

/* —— nothing fails silently ——
   A frozen app with no message is the worst thing to be handed, and there is
   no console on a phone. Anything that escapes a handler surfaces as a toast
   and is kept for Account → Diagnostics so it can actually be reported. */
export const lastErrors = [];
function noteError(what, err) {
  const msg = `${what}: ${err?.message || err}`;
  lastErrors.unshift({ at: Date.now(), msg });
  lastErrors.length = Math.min(lastErrors.length, 12);
  toast(msg.slice(0, 140), 'err');
}
addEventListener('error', (e) => noteError('Error', e.error || e.message));
addEventListener('unhandledrejection', (e) => noteError('Failed', e.reason));

/* —— back stack —— */
function goBack() {
  if (player) { closePlayer(); return true; }
  if (artView) { artView = null; renderArt(); return true; }
  if (filterModal) { filterModal = false; renderFModal(); syncScreens(); return true; }
  if (sheet) { closeSheet(); return true; }
  if (stack.length > 1) { navigate(null, 'pop'); return true; }
  if (route.name !== 'lib') { navigate({ name: 'lib' }, 'tab'); return true; }
  return false;
}
addEventListener('popstate', () => { goBack(); });
import('@capacitor/app').then(({ App }) => {
  App.addListener('backButton', () => { if (!goBack()) App.minimizeApp(); });
}).catch(() => {});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') goBack(); });

/* ————————————————— boot ————————————————— */
/* The boot screen goes away once the shelf (or the lock, or the sign-in form)
   is actually on screen — never before, so there is no flash of empty app. */
let bootGone = false;
function hideBoot() {
  if (bootGone) return;
  bootGone = true;
  const b = $('#boot');
  if (!b) return;
  b.classList.add('out');
  setTimeout(() => b.remove(), 320);
}
/* last resort: never strand the user behind the splash if boot throws */
setTimeout(hideBoot, 12000);

initAuth(async (signedIn) => {
  if (signedIn) {
    mountShell();
    stack = [];
    tabScreens.clear(); tabScroll.clear(); tabDirty.clear();
    route = { name: 'lib' };
    navigate(route, 'tab');
    /* bring the lock up BEFORE uncovering the app, so the shelf is never
       briefly visible on a locked device */
    await bioInit();
    showLock();
    hideBoot();
  } else {
    $('#lockwrap')?.remove();
    tabScreens.clear(); tabScroll.clear(); tabDirty.clear();
    stack = [];
    app.innerHTML = authHTML();
    hideBoot();
  }
});
