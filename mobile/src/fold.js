/* Pure logic ported from the desktop renderer (src/app.js) — grouping,
   season folding and the dub schedule math. Keep in lock-step with desktop:
   these two must agree on what "Season 3" means. */

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const normTitle = (t) => String(t || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function cleanSynopsis(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/\(Source:[^)]*\)\s*$/i, '').replace(/\n{3,}/g, '\n\n').trim();
}

/* ——— franchise grouping (identical to desktop groupEntries) ——— */
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
    if (at !== bt) return at - bt;
    const ay = a.year || 9999, by = b.year || 9999;
    if (ay !== by) return ay - by;
    return (b.popularity || 0) - (a.popularity || 0);
  })[0];
}
/* ═══════════════════════════════════════════════════════════════════════
   SHOWS AND FRANCHISES  (port of desktop src/app.js — keep in lock-step)

   A SHOW is one continuity. A FRANCHISE is the family of shows sharing a
   source. Unlimited Blade Works is a different SHOW from Fate/stay night in
   the same FRANCHISE — not its fourth season.

   Needs `rel` on franchise entries (frv 4). Records below that keep the old
   franchise-overlap grouping rather than guessing.
   ═══════════════════════════════════════════════════════════════════════ */
const FR_ACCESSORY = new Set(['MOVIE', 'OVA', 'SPECIAL', 'MUSIC']);
const FR_SERIES = new Set(['TV', 'TV_SHORT', 'ONA']);
export const FRV_RELATIONS = 4;

export function hasRelations(rec) {
  return (rec?.frv || 0) >= FRV_RELATIONS && (rec.franchise || []).some((f) => Array.isArray(f.rel));
}

/** Map<entryId, showId> over one franchise's entries. */
export function showMapFor(entries) {
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
  /* Rivals are two full SERIES. A film ALTERNATIVE to a TV arc is a recut of
     it (Demon Slayer's Mugen Train), not a competing adaptation. */
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
      /* A side story that is itself a series is its own show, else Steins;Gate
         swallows ChaoS;HEAd and Robotics;Notes. */
      if (r === 'SIDE_STORY' || r === 'PARENT') {
        if (FR_ACCESSORY.has(e.format) || FR_ACCESSORY.has(byId.get(other).format)) union(e.id, other);
      }
      /* ALTERNATIVE and SPIN_OFF never merge — that IS the franchise layer. */
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

export function showIdOf(rec) {
  if (!hasRelations(rec)) return null;
  return showMapFor(rec.franchise).get(rec.id) ?? null;
}

/** Every show in this record's franchise: [{ primaryId, entries, rep }]. */
export function franchiseShows(rec) {
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
      entries: entries.sort((a, c) => (a.sort || 0) - (c.sort || 0)),
      rep: entries.find((e) => e.id === primaryId) || entries[0]
    }))
    .sort((a, c) => (a.rep.sort || 0) - (c.rep.sort || 0));
}

export function computeGroups(entries) {
  /* Records that know their relation types group by SHOW; the rest fall back
     to the old franchise-overlap merge, so an un-migrated library behaves
     exactly as before rather than shuffling itself. */
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

/* ——— season folding (Mushoku's "5 seasons" are really 3) ——— */
export function isSeasonEntry(x) {
  if (['TV', 'TV_SHORT'].includes(x.format)) return true;
  if (['MOVIE', 'SPECIAL', 'MUSIC'].includes(x.format)) return false;
  return /(?:^|\s)(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season)(?:\s*(?:part|cour)\s*\d+)?\s*$/i
    .test(x.title || '');
}
export function foldedSeasons(fr) {
  const strip = (t) => normTitle(String(t || '').replace(/\s*[-–—:·]?\s*(?:part|cour)\s*\d+\s*$/i, ''));
  const out = [];
  for (const f of (fr || []).filter(isSeasonEntry)) {
    const key = strip(f.title);
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
   search is easy to get wrong — searching Fate/stay night mostly returns
   Unlimited Blade Works — and landing on season 4 of something you meant to
   start is never what was wanted. */
export function franchisePrimary(fr, fallback = null) {
  return foldedSeasons(fr)[0]?.parts?.[0] || fallback;
}

export function seasonDisplay(g, c) {
  const owner = g.members.find((m) => (m.franchise || []).some((f) => f.id === c.id)) || g.rep;
  const folded = foldedSeasons(owner.franchise);
  const se = folded.find((x) => x.parts.some((p) => p.id === c.id));
  if (se?.num && folded.filter((x) => x.num).length > 1) return { name: g.rep.title, season: se.num };
  return { name: c.title, season: null };
}

/* ——— dub schedule (identical to desktop dubInfo) ——— */
export function recHasDub(rec) {
  return (rec.dubLanguages || []).includes('English') || !!rec.dubSched?.dubPremier;
}
export function dubInfo(rec) {
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
    return null;
  }

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

/* ——— episode count ———
   A stored episodesList can be LONGER than the season really is: Kitsu and
   TVDB index some multi-season shows as one continuous run, so records
   enriched before that was fixed carry the whole franchise's episodes on a
   single season (The Asterisk War: 24 rows on a 12-episode season 1).
   AniList's per-season `episodes` is authoritative whenever it exists, so
   trust it over the list length and clip the surplus. */
export function episodesOf(rec) {
  const list = rec?.episodesList || [];
  const declared = Number(rec?.episodes) || 0;
  return declared && list.length > declared ? list.slice(0, declared) : list;
}
export const epCount = (rec) => episodesOf(rec).length || Number(rec?.episodes) || 0;

/* ——— watched helpers (records store watched keyed by season media id;
   read as a union across group members so it never matters which record
   a device wrote the tick onto) ——— */
export function watchedSet(group, seasonId) {
  const out = new Set();
  for (const m of group.members) {
    for (const n of (m.watched?.[seasonId] || [])) out.add(n);
  }
  return out;
}
export function watchedOwner(group, seasonId) {
  return group.members.find((m) => m.id === seasonId) || group.rep;
}
export function groupProgress(group) {
  let done = 0, total = 0;
  for (const m of group.members) {
    const eps = epCount(m);
    total += eps;
    done += Math.min(watchedSet(group, m.id).size, eps);
  }
  return { done, total };
}
