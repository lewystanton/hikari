/* AniList data layer for mobile — ported from desktop src/api.js.
   Same queries and the same record shape the desktop produces, so a show
   added here is complete in its own right. buildRecord returns the lite
   form (epv 0) and enrich.js immediately upgrades it on device; nothing
   waits on the desktop app, which may not exist. */

const ANILIST_URL = 'https://graphql.anilist.co';

/* ——— AniList pacing ———
   AniList's cap is 30 requests a minute PER IP, and the desktop app shares
   this household's IP. Two independent limiters, each assuming it owns the
   whole budget, is how adding a show could fail mid-search while the desktop
   quietly enriched in the background: 20/min here plus 24/min there against a
   30/min ceiling.

   So pace off `x-ratelimit-remaining`, which the server sends on every
   response and which counts EVERY client on this IP. That makes the two apps
   cooperate without either knowing the other exists.

   Requests are also ranked. Anything a person is waiting on — a search, a
   preview — goes to the front of the queue and may spend the whole budget.
   Background work (franchise walks, tag backfill, discover) queues behind it
   and parks once the shared budget runs low, so opening a show never fails
   because enrichment happened to be in flight. */
const AL_WINDOW = 60_000;
const AL_MIN_GAP = 350;
const AL_BG_FLOOR = 10;        // background work stops here, leaving room for the user

let alRemaining = null;        // last figure the server reported
let alSeenAt = 0;
let alLastAt = 0;
let alQueue = [];
let alPumping = false;
const jsleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alAcquire(bg) {
  return new Promise((resolve) => {
    alQueue.push({ bg, resolve });
    alQueue.sort((a, b) => (a.bg ? 1 : 0) - (b.bg ? 1 : 0));   // user first, stable
    alPump();
  });
}
async function alPump() {
  if (alPumping) return;
  alPumping = true;
  try {
    while (alQueue.length) {
      const now = Date.now();
      if (alRemaining != null && now - alSeenAt > AL_WINDOW) alRemaining = null;  // stale
      let wait = now - alLastAt < AL_MIN_GAP ? AL_MIN_GAP - (now - alLastAt) : 0;
      if (alQueue[0].bg && alRemaining != null && alRemaining <= AL_BG_FLOOR) {
        wait = Math.max(wait, AL_WINDOW - (now - alSeenAt) + 250);   // let the window roll
      }
      if (wait > 0) { await jsleep(Math.min(wait, 2000)); continue; }  // re-check: a user job may jump in
      alLastAt = Date.now();
      if (alRemaining != null) alRemaining--;      // optimistic; the response corrects it
      alQueue.shift().resolve();
    }
  } finally { alPumping = false; }
}
function alNoteHeaders(res) {
  const rem = parseInt(res.headers.get('x-ratelimit-remaining') || '', 10);
  if (Number.isFinite(rem)) { alRemaining = rem; alSeenAt = Date.now(); }
}
/* for Account → Diagnostics: is the app waiting on AniList, and how much of
   the shared per-IP budget is left? */
export const alBudget = () => ({
  remaining: alRemaining,
  queued: alQueue.length,
  waitingOnUser: alQueue.some((j) => !j.bg)
});

/* `opts.bg` marks work nobody is waiting on. */
export async function gql(query, variables, opts = {}) {
  const bg = !!opts.bg;
  for (let attempt = 0; attempt < 3; attempt++) {
    await alAcquire(bg);
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: opts.signal
    });
    alNoteHeaders(res);
    if (res.status === 429) {
      /* somebody on this IP outran the budget — sit out the rest of the window */
      alRemaining = 0; alSeenAt = Date.now();
      const ra = parseInt(res.headers.get('retry-after') || '0', 10) * 1000;
      if (attempt < 2) { await jsleep(Math.max(ra, 3000) + attempt * 2000); continue; }
      throw new Error('AniList is busy right now — try again in a moment');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.errors) throw new Error(json?.errors?.[0]?.message || `AniList failed (${res.status})`);
    return json.data;
  }
}

/* ——— search (dub flag via EN voice actors, like desktop) ——— */
const SEARCH_QUERY = `
query ($q: String) {
  Page(perPage: 10) {
    media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
      id idMal
      title { romaji english native }
      format seasonYear episodes averageScore popularity status genres
      coverImage { large color }
      characters(perPage: 8, sort: ROLE) {
        edges { node { id } voiceActors(language: ENGLISH) { id } }
      }
    }
  }
}`;
export async function searchAnime(q) {
  const data = await gql(SEARCH_QUERY, { q });
  return (data.Page.media || []).map((m) => ({
    ...m,
    dub: (m.characters?.edges || []).some((e) => e.voiceActors?.length)
  }));
}
export function seasonlessKey(m) {
  return (m.title.english || m.title.romaji || '')
    .toLowerCase()
    .replace(/(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season)(?:\s*(?:part|cour)\s*\d+)?/gi, ' ')
    .replace(/\b(?:part|cour)\s*\d+\b/gi, ' ')
    .replace(/\bfinal\s+season\b/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || `#${m.id}`;
}

/* ——— full detail → shelf record (port of desktop enrichShowBase) ——— */
const DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal siteUrl
    title { romaji english native }
    description(asHtml: false)
    format status season seasonYear episodes duration genres
    tags { name rank isMediaSpoiler isAdult }
    averageScore popularity
    coverImage { extraLarge large color }
    bannerImage
    studios(isMain: true) { nodes { name } }
    nextAiringEpisode { episode airingAt }
    trailer { id site }
    streamingEpisodes { title thumbnail url site }
    relations { edges { relationType node { id type format seasonYear title { romaji english } coverImage { large } } } }
    characters(perPage: 15, sort: ROLE) { edges { node { id } voiceActors { languageV2 } } }
    externalLinks { site url type language color }
  }
}`;
const RELATION_TYPES = ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'PARENT'];
const AUTO_SOURCES = ['Crunchyroll', 'HIDIVE'];

/* categories beyond AniList's fixed genre list live in TAGS (Harem, Isekai…) —
   keep confident, non-spoiler ones. Mirrors desktop pickTags exactly. */
export function pickTags(tags) {
  return (tags || [])
    .filter((t) => t && !t.isMediaSpoiler && !t.isAdult && (t.rank ?? 0) >= 40)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    .slice(0, 12)
    .map((t) => t.name);
}

function cleanDescription(html) {
  const withBreaks = String(html || '').replace(/<br\s*\/?>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

export async function buildRecord(mediaId) {
  const m = (await gql(DETAIL_QUERY, { id: mediaId })).Media;

  /* streamingEpisodes arrive newest-first; parse "Episode N" where present */
  const streams = (m.streamingEpisodes || []).map((e) => ({
    number: +(/episode\s*(\d+)/i.exec(e.title || '')?.[1] || 0) || null,
    title: (e.title || '').replace(/^Episode\s*\d+\s*[-–:]\s*/i, ''),
    thumbnail: e.thumbnail || '', url: e.url || '', site: e.site || ''
  })).reverse();
  const total = m.episodes || streams.length ||
    (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0);
  const byN = new Map(streams.filter((s) => s.number).map((s) => [s.number, s]));
  /* canonical episode-row shape = the desktop's: number/aired, not n/air */
  const episodesList = Array.from({ length: Math.max(total, streams.length) }, (_, i) => {
    const s = byN.get(i + 1) || (byN.size ? null : streams[i]);
    return {
      number: i + 1,
      title: s?.title || `Episode ${i + 1}`,
      thumbnail: s?.thumbnail || '',
      url: s?.url || '', site: s?.site || '',
      aired: '', filler: false
    };
  });

  const langRank = (l) => (l === 'Japanese' ? 0 : l === 'English' ? 1 : 2);
  const dubLanguages = [...new Set(
    (m.characters?.edges || []).flatMap((ed) => (ed.voiceActors || []).map((v) => v.languageV2)).filter(Boolean)
  )].sort((a, b) => langRank(a) - langRank(b) || a.localeCompare(b));

  const seasons = (m.relations?.edges || [])
    .filter((ed) => ed.node?.type === 'ANIME' && RELATION_TYPES.includes(ed.relationType))
    .map((ed) => ({
      id: ed.node.id, relation: ed.relationType,
      title: ed.node.title.english || ed.node.title.romaji || '',
      year: ed.node.seasonYear || null, format: ed.node.format || '',
      cover: ed.node.coverImage?.large || ''
    }));

  const streamingLinks = (m.externalLinks || [])
    .filter((l) => l.type === 'STREAMING' && l.url)
    .map((l) => ({ site: l.site || 'Stream', url: l.url, color: l.color || '', language: l.language || '' }));

  /* desktop convention: adopt Crunchyroll/HIDIVE as user sources automatically */
  const sources = [];
  for (const want of AUTO_SOURCES) {
    const hit = streamingLinks.find((l) => (l.site || '').toLowerCase().includes(want.toLowerCase()));
    if (hit) sources.push({ name: want, url: hit.url });
  }

  return {
    id: m.id, idMal: m.idMal || null, siteUrl: m.siteUrl || '',
    /* English first; romaji next; native only as a last resort. */
    title: m.title.english || m.title.romaji || m.title.native || '?',
    romaji: m.title.romaji || '', native: m.title.native || '',
    description: cleanDescription(m.description),
    format: m.format || '', status: m.status || '', season: m.season || '',
    year: m.seasonYear || null, episodes: m.episodes || null, duration: m.duration || null,
    genres: m.genres || [], tags: pickTags(m.tags),
    score: m.averageScore || null, popularity: m.popularity || null,
    cover: m.coverImage.extraLarge || m.coverImage.large || '',
    coverColor: m.coverImage.color || '', banner: m.bannerImage || '',
    studios: (m.studios?.nodes || []).map((n) => n.name),
    nextAiring: m.nextAiringEpisode
      ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt } : null,
    trailer: m.trailer?.site === 'youtube' && m.trailer.id ? { id: m.trailer.id } : null,
    episodeSource: 'partial', epv: 0,
    epSources: streams.length ? 'ANILIST' : 'NONE',
    episodesList, seasons, streamingLinks, sources,
    dubLanguages,
    watched: {}, addedAt: Date.now(), fetchedAt: Date.now()
  };
}

/* ——— discover: community recs, batched 50 shows a request ——— */
const REC_QUERY = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      recommendations(perPage: 8, sort: RATING_DESC) {
        nodes {
          rating
          mediaRecommendation {
            id title { romaji english } format seasonYear episodes
            averageScore popularity genres coverImage { large color }
          }
        }
      }
    }
  }
}`;
export async function fetchRecommendations(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql(REC_QUERY, { ids: ids.slice(i, i + 50) }, { bg: true });
    for (const m of data.Page.media || []) {
      map.set(m.id, (m.recommendations?.nodes || []).filter((n) => n?.mediaRecommendation));
    }
  }
  return map;
}
export async function fetchDubFlags(ids) {
  const out = new Map();
  const Q = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id
        characters(perPage: 3, sort: ROLE) {
          edges { node { id } voiceActors(language: ENGLISH) { id } }
        }
      }
    }
  }`;
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql(Q, { ids: ids.slice(i, i + 50) }, { bg: true });
    for (const m of data.Page.media || []) {
      out.set(m.id, (m.characters?.edges || []).some((e) => e.voiceActors?.length));
    }
  }
  return out;
}

/* ——— identify an anime from a screenshot (trace.moe) ———
   Reverse image search over an index of anime frames. It answers with AniList
   IDs — the same key a Hikari record is built on — so a hit drops straight
   into the normal add-to-shelf path with no extra plumbing.

   Anything below ~0.87 similarity is noise (trace.moe's own guidance): the
   engine always returns its nearest neighbours, so a screenshot of something
   it doesn't index still comes back with confident-looking rows in the 50s.
   Results are therefore CLASSIFIED, never presented as a flat answer.

   Keep this in lock-step between src/api.js and mobile/src/api.js. */
export const TRACE_URL = 'https://api.trace.moe/search';
const TRACE_CONFIDENT = 0.87;
const TRACE_PLAUSIBLE = 0.7;

export function traceConfidence(similarity) {
  if (similarity >= TRACE_CONFIDENT) return 'match';
  if (similarity >= TRACE_PLAUSIBLE) return 'maybe';
  return 'unlikely';
}

/* `input` is either a URL string or a Blob/File/ArrayBuffer of image data */
export async function traceMoeSearch(input, apiKey) {
  let url = `${TRACE_URL}?anilistInfo&cutBorders`;
  const opts = { method: 'GET', headers: {} };
  if (typeof input === 'string') {
    url += `&url=${encodeURIComponent(input)}`;
  } else {
    opts.method = 'POST';
    opts.body = input;
    opts.headers['Content-Type'] = input.type || 'application/octet-stream';
  }
  if (apiKey) opts.headers['x-trace-key'] = apiKey;

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error('Could not reach trace.moe — check your connection');
  }
  const quota = {
    remaining: Number(res.headers.get('x-ratelimit-remaining')),
    reset: Number(res.headers.get('x-ratelimit-reset')) * 1000
  };
  if (res.status === 402) throw Object.assign(new Error('Monthly search quota used up'), { quota });
  if (res.status === 429) {
    const mins = Math.max(1, Math.round((quota.reset - Date.now()) / 60000));
    throw Object.assign(new Error(`Too many searches — try again in ~${mins} min`), { quota });
  }
  let data;
  try { data = await res.json(); } catch { throw new Error(`trace.moe returned ${res.status}`); }
  if (data.error) throw new Error(String(data.error).slice(0, 160));

  /* the same scene matches over a run of frames — collapse to one row per show */
  const best = new Map();
  for (const m of data.result || []) {
    const id = m.anilist?.id;
    if (!id) continue;
    const prev = best.get(id);
    if (!prev || m.similarity > prev.similarity) best.set(id, m);
  }
  const results = [...best.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map((m) => ({
      id: m.anilist.id,
      idMal: m.anilist.idMal || null,
      title: m.anilist.title?.english || m.anilist.title?.romaji || `#${m.anilist.id}`,
      romaji: m.anilist.title?.romaji || '',
      native: m.anilist.title?.native || '',
      isAdult: !!m.anilist.isAdult,
      episode: Array.isArray(m.episode) ? m.episode[0] : m.episode,
      from: m.from, to: m.to,
      similarity: m.similarity,
      confidence: traceConfidence(m.similarity),
      scene: m.image || '',
      clip: m.video || ''
    }));
  return { results, quota };
}

/* "12:34" from trace.moe's seconds-into-the-episode */
export function traceStamp(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Cover art + meta for a set of ids, so an identify result can be rendered as
   a normal search row rather than a bare scene thumbnail. One batched query. */

/* Exact start dates for announced entries.
   The franchise walk keeps year + month only, which sorts but cannot say
   "14 Oct 2026". A date is treated as confirmed only when the DAY is known.
   Keep in step with desktop src/api.js. */
export async function fetchUpcoming(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const Q = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id status episodes format
        startDate { year month day }
        nextAiringEpisode { airingAt }
        coverImage { large color }
      }
    }
  }`;
  const data = await gql(Q, { ids }, { bg: true });
  for (const m of data.Page.media || []) {
    const d = m.startDate || {};
    const at = d.year && d.month && d.day
      ? new Date(d.year, d.month - 1, d.day).getTime()
      : (m.nextAiringEpisode?.airingAt ? m.nextAiringEpisode.airingAt * 1000 : null);
    out.set(m.id, {
      at, episodes: m.episodes || null, format: m.format || '',
      status: m.status || '', cover: m.coverImage?.large || '', fetchedAt: Date.now()
    });
  }
  return out;
}

export async function fetchBasics(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const Q = `
  query ($ids: [Int]) {
    Page(perPage: 50) {
      media(id_in: $ids, type: ANIME) {
        id
        format seasonYear episodes averageScore
        coverImage { large color }
        characters(perPage: 3, sort: ROLE) {
          edges { node { id } voiceActors(language: ENGLISH) { id } }
        }
      }
    }
  }`;
  const data = await gql(Q, { ids });
  for (const m of data.Page.media || []) {
    out.set(m.id, {
      cover: m.coverImage?.large || '',
      color: m.coverImage?.color || '',
      format: m.format || '',
      year: m.seasonYear || null,
      episodes: m.episodes || null,
      score: m.averageScore || null,
      dub: (m.characters?.edges || []).some((e) => e.voiceActors?.length)
    });
  }
  return out;
}

/* Live quota straight from trace.moe, without spending a search.
   The window is 24 hours — the service's own account page labels it
   "Daily Search Quota (24-hour period)". Note the `x-ratelimit-*` headers are
   a *different*, per-minute cap; don't conflate the two. */
export async function fetchTraceQuota(apiKey) {
  const res = await fetch('https://api.trace.moe/me', {
    headers: apiKey ? { 'x-trace-key': apiKey } : {}
  });
  if (!res.ok) throw new Error(`trace.moe returned ${res.status}`);
  const j = await res.json();
  const total = Number(j.quota);
  const used = Number(j.quotaUsed);
  if (!Number.isFinite(total)) return null;
  return { total, used, remaining: Math.max(0, total - used), keyed: !!apiKey };
}
