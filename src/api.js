/* Hikari — data layer. AniList GraphQL (primary) + Jikan (episode-list fallback). */
'use strict';

const ANILIST_URL = 'https://graphql.anilist.co';

const SEARCH_QUERY = `
query ($q: String) {
  Page(perPage: 9) {
    media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      title { romaji english native }
      format
      seasonYear
      episodes
      averageScore
      popularity
      status
      genres
      coverImage { large color }
      characters(perPage: 8, sort: ROLE) {
        edges { node { id } voiceActors(language: ENGLISH) { id } }
      }
    }
  }
}`;

const DETAIL_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    idMal
    siteUrl
    title { romaji english native }
    description(asHtml: false)
    format
    status
    season
    seasonYear
    episodes
    duration
    genres
    tags { name rank isMediaSpoiler isAdult }
    averageScore
    popularity
    coverImage { extraLarge large color }
    bannerImage
    studios(isMain: true) { nodes { name } }
    nextAiringEpisode { episode airingAt }
    trailer { id site }
    streamingEpisodes { title thumbnail url site }
    relations {
      edges {
        relationType
        node {
          id
          type
          format
          seasonYear
          title { romaji english }
          coverImage { large }
        }
      }
    }
    characters(perPage: 15, sort: ROLE) {
      edges { node { id } voiceActors { languageV2 } }
    }
    externalLinks { site url type language color }
  }
}`;

/* ——— AniList pacing ———
   The cap is 30 requests a minute PER IP, and the phone shares this
   household's IP. Two independent limiters, each assuming it owns the whole
   budget, is how adding a show on the phone could fail while this app quietly
   enriched in the background: 24/min here plus 20/min there against a 30/min
   ceiling.

   So pace off `x-ratelimit-remaining`, which the server returns on every
   response and which counts EVERY client on this IP. The two apps then
   cooperate without either knowing the other exists.

   Requests are ranked too: anything a person is waiting on goes to the front
   and may spend the whole budget, while background work (franchise walks, art
   pools, the auto-refresh sweep) parks once the shared budget runs low.
   Keep this in lock-step with mobile/src/api.js. */
const AL_WINDOW = 60_000;
const AL_MIN_GAP = 350;
const AL_BG_FLOOR = 10;     // background work stops here, leaving room for the user

let alRemaining = null;     // last figure the server reported
let alSeenAt = 0;
let alLastAt = 0;
const alQueue = [];
let alPumping = false;
const alSleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      if (wait > 0) { await alSleep(Math.min(wait, 2000)); continue; }  // re-check: a user job may jump in
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

/* Third argument stays back-compatible with the callers that pass a bare
   AbortSignal; `{ signal, bg }` is the fuller form. */
async function gql(query, variables, opts) {
  const o = opts instanceof AbortSignal ? { signal: opts } : (opts || {});
  const bg = !!o.bg;
  for (let attempt = 0; attempt < 3; attempt++) {
    await alAcquire(bg);
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: o.signal
    });
    alNoteHeaders(res);
    if (res.status === 429) {
      /* somebody on this IP outran the budget — sit out the rest of the window */
      alRemaining = 0; alSeenAt = Date.now();
      const ra = parseInt(res.headers.get('retry-after') || '0', 10) * 1000;
      if (attempt < 2) {
        await alSleep(Math.max(ra, 3000) + attempt * 2000);
        continue;
      }
      throw new Error('AniList is busy right now — try again in a moment');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.errors) {
      const msg = json?.errors?.[0]?.message || `AniList request failed (${res.status})`;
      throw new Error(msg);
    }
    return json.data;
  }
}

async function searchAnime(q, signal) {
  const data = await gql(SEARCH_QUERY, { q }, signal);
  return data.Page.media || [];
}

/* ——— community recommendations, batched: one request per 50 shows ——— */
const REC_QUERY = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      recommendations(perPage: 8, sort: RATING_DESC) {
        nodes {
          rating
          mediaRecommendation {
            id
            title { romaji english }
            format
            seasonYear
            episodes
            averageScore
            popularity
            genres
            coverImage { large color }
          }
        }
      }
    }
  }
}`;

async function fetchRecommendations(ids) {
  const map = new Map(); // source media id -> rec nodes
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql(REC_QUERY, { ids: ids.slice(i, i + 50) }, { bg: true });
    for (const m of data.Page.media || []) {
      map.set(m.id, (m.recommendations?.nodes || []).filter((n) => n?.mediaRecommendation));
    }
  }
  return map;
}

async function fetchDetail(id) {
  const data = await gql(DETAIL_QUERY, { id });
  return data.Media;
}

/* ——— dub schedules (AnimeSchedule.net, keyless, by MAL id) ———
   The only legitimate structured source of separate dub air data:
   dubPremier + weekly dubTime + recorded dub delay windows. */
async function fetchDubSchedule(idMal) {
  const j = await window.hikari.fetchJson(`https://animeschedule.net/api/v3/anime?mal-ids=${idMal}`);
  const a = (j?.anime || (Array.isArray(j) ? j : []))[0];
  if (!a) return null;
  const iso = (v) => (v && !String(v).startsWith('0001-') ? v : null);
  return {
    dubPremier: iso(a.dubPremier),
    dubTime: iso(a.dubTime),
    subTime: iso(a.subTime),
    jpnTime: iso(a.jpnTime),
    dubDelayedFrom: iso(a.dubDelayedFrom),
    dubDelayedUntil: iso(a.dubDelayedUntil),
    route: a.route || ''
  };
}

/* EN-dub flags for a batch of media ids — kept OUT of the recommendations
   query (nesting voice actors there blows AniList's complexity cap) */
async function fetchDubFlags(ids) {
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

/* trailer only — a light upgrade for records saved before trailers existed */
async function fetchTrailerId(id) {
  const data = await gql('query($id:Int){Media(id:$id,type:ANIME){trailer{id site}}}', { id });
  const t = data.Media?.trailer;
  return t?.site === 'youtube' && t.id ? { id: t.id } : null;
}

/* ——— title similarity (used by the local-media folder matcher) ——— */
function ytNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/* ——— word-set title similarity ———
   Folder names routinely drop or add a single word — "NAKAIMO - My Little
   Sister Is Among Them!" gets filed as "Nakaimo - My Sister is Among Them!".
   That defeats both of the other strategies at once: neither string contains
   the other, and the 7-character gap immediately blows the Levenshtein cap.
   Comparing WORD SETS bridges it.

   Deliberately strict: one set has to be a clean subset of the other, and
   cover at least 80% of it. That accepts one missing word in six but refuses
   "Sword Art Online" ⊂ "Sword Art Online Alternative" (3/4 = 0.75), which are
   genuinely different shows. */
function ytTokens(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}
function tokenSubsetScore(aTokens, bTokens) {
  if (!aTokens?.length || !bTokens?.length) return 0;
  const A = new Set(aTokens), B = new Set(bTokens);
  if (A.size < 2 || B.size < 2) return 0;              // too little to be sure
  const small = A.size <= B.size ? A : B;
  const large = A.size <= B.size ? B : A;
  for (const t of small) if (!large.has(t)) return 0;  // must be a clean subset
  const ratio = small.size / large.size;
  return ratio >= 0.8 ? 0.9 * ratio : 0;
}
function ytSimilar(cand, media) {
  const c = ytNorm(cand);
  if (c.length < 4) return 0;
  /* compare against full titles AND their pre-subtitle segments —
     "Demon Slayer" must hit "Demon Slayer: Kimetsu no Yaiba" */
  const variants = [];
  for (const t of [media.title?.english, media.title?.romaji].filter(Boolean)) {
    variants.push(t);
    const cut = t.split(/[:：–—-]/)[0].trim();
    if (cut && cut.length >= 4 && cut !== t) variants.push(cut);
  }
  let best = 0;
  for (const t of variants) {
    const n = ytNorm(t);
    if (!n) continue;
    if (n === c) best = Math.max(best, 1);
    else if (n.includes(c) && c.length / n.length >= 0.4) best = Math.max(best, 0.85);
    else if (c.includes(n) && n.length / c.length >= 0.4) best = Math.max(best, 0.8);
    else best = Math.max(best, tokenSubsetScore(ytTokens(cand), ytTokens(t)));
  }
  return best;
}

/* ——— franchise graph traversal ———
   AniList relations are one hop deep, so a show only knows its direct
   neighbours (S1 → S2, but never S3/S4). We BFS the relation graph,
   following season/story edges, then hydrate every discovered title. */

const REL_BATCH_QUERY = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      relations { edges { relationType node { id type } } }
    }
  }
}`;

const HYDRATE_QUERY = `
query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id
      format
      status
      seasonYear
      startDate { year month }
      episodes
      title { romaji english native }
      synonyms
      coverImage { large }
      bannerImage
      characters(perPage: 8, sort: ROLE) {
        edges { node { id } voiceActors(language: ENGLISH) { id } }
      }
    }
  }
}`;

/* Edges we traverse through; SPIN_OFF is included but not expanded,
   so crossover chains can't drag in unrelated franchises. */
const EXPAND_RELS = ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'SUMMARY', 'ALTERNATIVE'];
const INCLUDE_RELS = [...EXPAND_RELS, 'SPIN_OFF'];
const FRANCHISE_CAP = 40;

async function fetchFranchise(rootId) {
  const seen = new Set([rootId]);
  const relMap = new Map();
  const expandable = new Set([rootId]);
  let frontier = [rootId];

  for (let depth = 0; depth < 5 && frontier.length; depth++) {
    const data = await gql(REL_BATCH_QUERY, { ids: frontier }, { bg: true });
    const next = [];
    for (const m of data.Page.media || []) {
      relMap.set(m.id, (m.relations?.edges || [])
        .filter((e) => e.node?.type === 'ANIME')
        .map((e) => [e.node.id, e.relationType]));
      for (const ed of m.relations?.edges || []) {
        const n = ed.node;
        if (!n || n.type !== 'ANIME') continue;
        if (!INCLUDE_RELS.includes(ed.relationType)) continue;
        if (seen.has(n.id) || seen.size >= FRANCHISE_CAP) continue;
        seen.add(n.id);
        if (EXPAND_RELS.includes(ed.relationType)) {
          expandable.add(n.id);
          next.push(n.id);
        }
      }
    }
    frontier = next;
  }

  const ids = [...seen];

  /* The BFS only asked the frontier for its relations, so leaf nodes have none
     recorded. Fill the gaps: the relation TYPES are what tell a sequel from a
     reboot, and without them every entry looks equally related to every other
     — which is exactly how Unlimited Blade Works ended up as season 4 of
     Fate/stay night. One extra batched request, and only for what's missing. */
  const unknown = ids.filter((id) => !relMap.has(id));
  for (let i = 0; i < unknown.length; i += 50) {
    try {
      const d = await gql(REL_BATCH_QUERY, { ids: unknown.slice(i, i + 50) }, { bg: true });
      for (const m of d.Page.media || []) {
        relMap.set(m.id, (m.relations?.edges || [])
          .filter((e) => e.node?.type === 'ANIME')
          .map((e) => [e.node.id, e.relationType]));
      }
    } catch { /* partial relations still beat none */ }
  }

  const media = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql(HYDRATE_QUERY, { ids: ids.slice(i, i + 50) }, { bg: true });
    media.push(...(d.Page.media || []));
  }

  const mapped = media
    .filter((m) => m.format !== 'MUSIC')
    .map((m) => ({
      id: m.id,
      format: m.format || '',
      status: m.status || '',
      year: m.seasonYear || m.startDate?.year || null,
      sort: (m.startDate?.year || 9999) * 100 + (m.startDate?.month || 0),
      episodes: m.episodes || null,
      dub: (m.characters?.edges || []).some((e) => e.voiceActors?.length),
      en: m.title.english || '',
      romaji: m.title.romaji || '',
      native: m.title.native || '',
      syn: m.synonyms || [],
      cover: m.coverImage?.large || '',
      banner: m.bannerImage || '',
      /* [otherId, relationType], kept only for entries inside this franchise */
      rel: (relMap.get(m.id) || []).filter(([other]) => seen.has(other))
    }))
    .sort((a, b) => a.sort - b.sort);

  /* ——— English first, and honestly ———
     AniList leaves `title.english` null on ~1 in 4 entries here, mostly
     specials and unaired seasons. Two safe ways to recover a real English
     name, then plain fallbacks. Nothing is invented.

     A) PREFIX SPLICE. If a sibling's romaji is a prefix of this one, reuse the
        sibling's English for that prefix: "Tate no Yuusha … Season 5" becomes
        "The Rising of the Shield Hero Season 5".

     B) VOUCHED SYNONYM. AniList's `synonyms` is a grab-bag: it holds the real
        English name ("The Testament of Sister New Devil BURST Specials") right
        next to literal translations nobody uses (Sekirei → "Wagtail") and
        worse renames (High School DxD NEW → "High School DxD 2"). So a synonym
        is only trusted when it CONTAINS a franchise sibling's English title —
        that is what tells us it is the show's English naming rather than
        somebody's gloss.

     Then romaji, then native. */
  const withEn = mapped.filter((x) => x.en && x.romaji);
  const isLatin = (t) => !/[぀-ヿ㐀-䶿一-鿿가-힯]/.test(t || '');

  for (const x of mapped) {
    if (x.en) { x.title = x.en; continue; }

    /* A — longest matching prefix wins */
    let best = null;
    for (const w of withEn) {
      if (w.id !== x.id && x.romaji.startsWith(w.romaji) && (!best || w.romaji.length > best.romaji.length)) {
        best = w;
      }
    }
    if (best) { x.title = best.en + x.romaji.slice(best.romaji.length); continue; }

    /* B — a synonym vouched for by a sibling's English title */
    const vouched = (x.syn || [])
      .filter(isLatin)
      .filter((cand) => withEn.some((w) => w.id !== x.id && w.en.length > 6
        && cand.toLowerCase().includes(w.en.toLowerCase())))
      .sort((a, c) => c.length - a.length)[0];
    if (vouched) { x.title = vouched; continue; }

    x.title = x.romaji || x.native || '';
  }
  return mapped.map(({ en, romaji, syn, ...rest }) => rest);
}

const jsleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ——— artwork pool: alternate posters + fanart from every source we speak ———
   AniList (franchise covers/banners) + MAL pictures (poster variants) +
   Kitsu (poster + wide cover) + TVDB via Skyhook (posters, banners, fanart). */
/* TMDB full galleries (needs the user's free v3 key) — the Plex-tier source.
   Show-level posters/backdrops + per-season posters, all variants. */
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
async function fetchTmdbImages(malId, key) {
  const out = { covers: [], banners: [] };
  if (!key) return out;
  try {
    const arm = await window.hikari.fetchJson(`https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${malId}`);
    const tmdbId = arm?.themoviedb;
    if (!tmdbId) return out;
    const media = arm?.media === 'MOVIE' ? 'movie' : 'tv';

    const imgs = await fetch(`https://api.themoviedb.org/3/${media}/${tmdbId}/images?api_key=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null));
    for (const p of imgs?.posters || []) out.covers.push(`${TMDB_IMG}w500${p.file_path}`);
    /* backdrops become full-bleed heroes — fetch originals, not w1280 */
    for (const b of imgs?.backdrops || []) out.banners.push(`${TMDB_IMG}original${b.file_path}`);

    if (media === 'tv') {
      /* every season's poster gallery, not just the mapped one */
      const detail = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(key)}`)
        .then((r) => (r.ok ? r.json() : null));
      const seasonNums = (detail?.seasons || [])
        .map((x) => x.season_number)
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 8);
      if (!seasonNums.length) seasonNums.push(1);
      for (const n of seasonNums) {
        const sImgs = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${n}/images?api_key=${encodeURIComponent(key)}`)
          .then((r) => (r.ok ? r.json() : null));
        for (const p of sImgs?.posters || []) out.covers.push(`${TMDB_IMG}w500${p.file_path}`);
      }
    }
  } catch { /* no tmdb art */ }
  return out;
}

/* fanart.tv (optional key) — HD community galleries keyed by TVDB id */
async function fetchFanartImages(malId, key) {
  const out = { covers: [], banners: [] };
  if (!key) return out;
  try {
    const arm = await window.hikari.fetchJson(`https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${malId}`);
    if (!arm?.thetvdb) return out;
    const data = await window.hikari.fetchJson(`https://webservice.fanart.tv/v3/tv/${arm.thetvdb}?api_key=${encodeURIComponent(key)}`);
    if (!data) return out;
    for (const p of data.tvposter || []) out.covers.push(p.url);
    for (const p of data.seasonposter || []) out.covers.push(p.url);
    for (const b of data.showbackground || []) out.banners.push(b.url);
    for (const b of data.tvbanner || []) out.banners.push(b.url);
  } catch { /* no fanart */ }
  return out;
}

/* Every provider used to be awaited in turn — TMDB, then fanart, then
   AniList, then a serial Jikan loop that sleeps 500ms between ids and 1200ms
   between retries, then Kitsu, then TVDB. Worst case that is well over ten
   seconds of which most is waiting on nothing, and Jikan /pictures 504s on a
   cold cache so its retries stall on connection timeouts.

   They are independent, so run them together. Only Jikan depends on another
   (it needs MAL ids from the AniList query), so it chains off that one.
   Results are reassembled in the original provider order because position in
   `covers`/`banners` IS the preference order — artPool.banners[0] becomes the
   hero. Anything that fails or times out contributes nothing. */
const ART_TIMEOUT = 8000;
function artTimeout(ms = ART_TIMEOUT) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}
/* a provider that hangs must not hold up the ones that answered */
function capped(promise, ms = ART_TIMEOUT + 4000) {
  return Promise.race([
    promise,
    new Promise((res) => setTimeout(() => res({ covers: [], banners: [] }), ms))
  ]).catch(() => ({ covers: [], banners: [] }));
}

/* `bg` is the difference between a sweep nobody is watching and one the user
   just asked for. Measured on Slime: every provider answers in under 220ms
   on its own, but the AniList leg runs through the rate limiter, so when a
   franchise crawl is already queued it lands 12s later and Promise.all makes
   the other five wait for it. User-initiated sweeps jump that queue. */
async function fetchArtPool(anilistIds, malId, keys = {}, { bg = true } = {}) {
  const empty = { covers: [], banners: [] };

  const pTmdb = keys.tmdb ? capped(fetchTmdbImages(malId, keys.tmdb)) : Promise.resolve(empty);
  const pFanart = keys.fanart ? capped(fetchFanartImages(malId, keys.fanart)) : Promise.resolve(empty);

  /* AniList first, then Jikan off the MAL ids it returns */
  const pAniAndJikan = capped((async () => {
    const covers = [], banners = [];
    const jikanCovers = [];
    const d = await gql(
      'query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id idMal coverImage{extraLarge large} bannerImage}}}',
      { ids: anilistIds.slice(0, 50) }, { bg }
    );
    const media = d.Page.media || [];
    for (const m of media) {
      const c = m.coverImage?.extraLarge || m.coverImage?.large;
      if (c) covers.push(c);
      if (m.bannerImage) banners.push(m.bannerImage);
    }
    /* Jikan allows 3/sec. Three at a time with a hard timeout beats five in
       series with sleeps between them, and a 504 now costs 8s once rather
       than a connection timeout plus a 1200ms backoff plus a retry. */
    const malIds = media.map((m) => m.idMal).filter(Boolean).slice(0, 3);
    await Promise.all(malIds.map(async (id) => {
      try {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${id}/pictures`,
          { signal: artTimeout() });
        if (!res.ok) return;
        const j = await res.json();
        for (const p of j.data || []) {
          const u = p.jpg?.large_image_url || p.jpg?.image_url;
          if (u) jikanCovers.push(u);
        }
      } catch { /* one provider short */ }
    }));
    return { covers: [...covers, ...jikanCovers], banners };
  })());

  const pKitsu = capped((async () => {
    const covers = [], banners = [];
    const m = await fetch(
      `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
      { signal: artTimeout() }).then((r) => (r.ok ? r.json() : null));
    const at = m?.included?.[0]?.attributes;
    if (at?.posterImage?.original) covers.push(at.posterImage.original);
    if (at?.coverImage?.original) banners.push(at.coverImage.original);
    return { covers, banners };
  })());

  const pTvdb = capped((async () => {
    const covers = [], banners = [];
    const arm = await window.hikari.fetchJson(`https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${malId}`);
    if (arm?.thetvdb) {
      let show = tvdbShowCache.get(arm.thetvdb);
      if (!show) {
        show = await window.hikari.fetchJson(`https://skyhook.sonarr.tv/v1/tvdb/shows/en/${arm.thetvdb}`);
        if (show) tvdbShowCache.set(arm.thetvdb, show);
      }
      for (const im of show?.images || []) {
        const t = (im.coverType || '').toLowerCase();
        if (t === 'fanart' || t === 'banner') banners.push(im.url);
        else if (t === 'poster') covers.push(im.url);
      }
    }
    return { covers, banners };
  })());

  /* order here is the preference order, and must match the old sequence */
  const parts = await Promise.all([pTmdb, pFanart, pAniAndJikan, pKitsu, pTvdb]);
  const covers = parts.flatMap((p) => p?.covers || []);
  const banners = parts.flatMap((p) => p?.banners || []);
  return { covers: [...new Set(covers)], banners: [...new Set(banners)] };
}

/* MyAnimeList via Jikan — authoritative episode list (numbers, titles, air dates, filler) */
async function fetchJikanEpisodes(malId) {
  if (!malId) return [];
  const out = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`);
      if (!res.ok) break;
      const json = await res.json();
      out.push(...(json.data || []).map((e) => ({
        number: e.mal_id,
        title: e.title || `Episode ${e.mal_id}`,
        aired: e.aired ? e.aired.slice(0, 10) : '',
        filler: !!e.filler,
        recap: !!e.recap,
        score: e.score ?? null
      })));
      if (!json.pagination?.has_next_page) break;
      await jsleep(360);
    }
  } catch { /* partial is fine */ }
  return out;
}

/* Kitsu — per-episode thumbnails (mapped from the MAL id, no key needed) */
async function fetchKitsuEpisodes(malId) {
  const empty = { count: 0, map: new Map() };
  if (!malId) return empty;
  try {
    const mres = await fetch(`https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`);
    if (!mres.ok) return empty;
    const mjson = await mres.json();
    const kitsuId = mjson.included?.[0]?.id;
    if (!kitsuId) return empty;

    const map = new Map();
    let count = 0;
    for (let offset = 0; offset < 160; offset += 20) {
      const res = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
      if (!res.ok) break;
      const json = await res.json();
      if (!json.data?.length) break;
      count = json.meta?.count || count;
      for (const e of json.data) {
        const a = e.attributes || {};
        if (a.number != null && !map.has(a.number)) {
          map.set(a.number, {
            title: a.canonicalTitle || '',
            thumbnail: a.thumbnail?.original || '',
            aired: a.airdate || '',
            synopsis: a.synopsis || '',
            length: a.length || null
          });
        }
      }
      if (!json.links?.next) break;
      await jsleep(220);
    }
    return { count, map };
  } catch {
    return empty;
  }
}

/* TVDB stills via ARM (mal id → tvdb id + season) and Sonarr's public Skyhook.
   This is the Plex-grade source — complete stills where Kitsu peters out. */
const tvdbShowCache = new Map();
async function fetchTvdbEpisodes(malId, firstAired = null) {
  const empty = new Map();
  if (!malId || !window.hikari.fetchJson) return empty;
  try {
    const arm = await window.hikari.fetchJson(`https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${malId}`);
    const tvdbId = arm?.thetvdb;
    if (!tvdbId) return empty;
    const season = Number.isInteger(arm['thetvdb-season']) && arm['thetvdb-season'] > 0 ? arm['thetvdb-season'] : 1;

    let show = tvdbShowCache.get(tvdbId);
    if (!show) {
      show = await window.hikari.fetchJson(`https://skyhook.sonarr.tv/v1/tvdb/shows/en/${tvdbId}`);
      if (show) tvdbShowCache.set(tvdbId, show);
    }
    if (!show?.episodes) return empty;

    /* A split cour is ONE season on TVDB and TWO entries on AniList: Slime
       Season 2 Part 2 is episodes 1-12 to AniList and 13-24 to TVDB. Asking
       for 1-12 therefore handed Part 2 the stills and overviews belonging to
       Part 1 — the titles were right (those come from Jikan) but every image
       was a duplicate.

       Align on AIR DATE instead of trusting the numbering: find the TVDB
       episode that aired when this entry's first episode aired, and shift the
       whole season by that offset. Falls back to no shift when there is no
       date to match on. */
    const seasonEps = show.episodes
      .filter((e) => e.seasonNumber === season && e.episodeNumber != null)
      .sort((a, b) => a.episodeNumber - b.episodeNumber);

    let offset = 0;
    if (firstAired) {
      const want = String(firstAired).slice(0, 10);
      const hit = seasonEps.find((e) => String(e.airDate || '').slice(0, 10) === want);
      if (hit) offset = hit.episodeNumber - 1;
    }

    const map = new Map();
    for (const e of seasonEps) {
      const n = e.episodeNumber - offset;
      if (n < 1) continue;
      if (!map.has(n)) {
        map.set(n, {
          title: e.title || '',
          thumbnail: e.image || '',
          aired: e.airDate || '',
          overview: e.overview || '',
          absolute: e.absoluteEpisodeNumber || null
        });
      }
    }
    return map;
  } catch {
    return empty;
  }
}

/* One list to rule them all:
   AniList (watch links) + MAL (canon list) + TVDB (stills) + Kitsu (stills) */
function mergeEpisodes(totalHint, anilistEps, jikanRows, kitsu, tvdb = new Map()) {
  /* Jikan sometimes serves an oversized junk payload (rows beyond the entry's
     own episode count) — truncate and stop trusting its titles when it does. */
  let jr = jikanRows;
  let jikanSuspect = false;
  if (totalHint && jr.length > totalHint) {
    jikanSuspect = true;
    jr = jr.filter((r) => r.number >= 1 && r.number <= totalHint);
  }

  /* AniList's episode count is per-SEASON and authoritative when it exists.
     Kitsu and TVDB routinely index a multi-season show as one continuous run
     (TVDB has all 24 Asterisk War episodes under one series), so taking the
     max across sources handed a 12-episode season 24 rows — the same
     over-long-source problem the Jikan clamp above already guards against.
     Only let the other sources set the count when AniList doesn't know it. */
  const canonical = totalHint || Math.max(jr.length, kitsu.count || 0, kitsu.map.size, tvdb.size);

  /* AniList/Crunchyroll often numbers episodes absolutely across seasons
     ("Episode 14…25" for a 12-episode S3) — re-base to season-relative. */
  let anEps = anilistEps.filter((e) => e.number != null);
  if (canonical && anEps.length) {
    const min = Math.min(...anEps.map((e) => e.number));
    const max = Math.max(...anEps.map((e) => e.number));
    if (min > 1 || max > canonical) {
      const offset = min - 1;
      anEps = anEps
        .map((e) => ({ ...e, number: e.number - offset }))
        .filter((e) => e.number >= 1 && e.number <= canonical);
    }
  }
  const anMap = new Map();
  for (const e of anEps) {
    if (!anMap.has(e.number)) anMap.set(e.number, e);
  }
  const N = canonical || (anMap.size ? Math.max(...anMap.keys()) : 0);
  if (!N) {
    return anilistEps.map((e) => ({
      number: e.number, title: e.title, thumbnail: e.thumbnail,
      url: e.url, site: e.site, aired: '', filler: false
    }));
  }
  const jMap = new Map(jr.map((r) => [r.number, r]));
  const rows = [];
  for (let i = 1; i <= N; i++) {
    const a = anMap.get(i), j = jMap.get(i), k = kitsu.map.get(i), t = tvdb.get(i);
    const titleOrder = jikanSuspect
      ? [t?.title, k?.title, j?.title]
      : [j?.title, t?.title, k?.title];
    const airedOrder = jikanSuspect
      ? [t?.aired, k?.aired, j?.aired]
      : [j?.aired, t?.aired, k?.aired];
    rows.push({
      number: i,
      title: titleOrder.find(Boolean) || (a ? a.title.replace(/^Episode\s*\d+\s*[-–—]\s*/i, '') : `Episode ${i}`),
      thumbnail: t?.thumbnail || k?.thumbnail || a?.thumbnail || '',
      url: a?.url || '',
      site: a?.url ? (a.site || '') : '',
      aired: (airedOrder.find(Boolean) || '').slice(0, 10),
      filler: !!j?.filler,
      recap: !!j?.recap,
      overview: t?.overview || k?.synopsis || '',
      runtime: k?.length || null,
      absolute: t?.absolute || null,
      score: j?.score ?? null
    });
  }
  return rows;
}

function cleanDescription(html) {
  const withBreaks = String(html || '').replace(/<br\s*\/?>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

const RELATION_TYPES = ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'SPIN_OFF', 'ALTERNATIVE', 'SUMMARY', 'PARENT'];

/* AniList genres are a fixed ~19-item list; the interesting categories
   (Harem, Isekai, Reincarnation…) are TAGS. Keep the confident, non-spoiler
   ones — they feed the same filter the genres do. */
function pickTags(tags) {
  return (tags || [])
    .filter((t) => t && !t.isMediaSpoiler && !t.isAdult && (t.rank ?? 0) >= 40)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
    .slice(0, 12)
    .map((t) => t.name);
}

/* Fast add: ONE AniList call → an instantly-usable partial record.
   epv:0 and a missing `franchise` key make the existing background
   upgraders (upgradeEpisodes / upgradeFranchise) fill the rest in. */
/* Episode-data version. BUMP THIS whenever the episode pipeline changes
   what it produces, or records already at the old number never re-enrich:
   the TVDB split-cour alignment shipped in 3.0.1 without a bump, so every
   existing record kept Part 1 stills on Part 2 indefinitely.
     5 -> 6: air-date alignment for split cours. */
const EP_VERSION = 6;

async function enrichShowBase(mediaId) {
  const m = await fetchDetail(mediaId);
  const anilistEps = (m.streamingEpisodes || []).map((e) => {
    const match = /episode\s*(\d+)/i.exec(e.title || '');
    return {
      number: match ? +match[1] : null,
      title: e.title || '',
      thumbnail: e.thumbnail || '',
      url: e.url || '',
      site: e.site || ''
    };
  });
  const eps = mergeEpisodes(m.episodes, anilistEps, [], { count: 0, map: new Map() }, new Map());

  const langRank = (l) => (l === 'Japanese' ? 0 : l === 'English' ? 1 : 2);
  const dubLanguages = [...new Set(
    (m.characters?.edges || [])
      .flatMap((ed) => (ed.voiceActors || []).map((v) => v.languageV2))
      .filter(Boolean)
  )].sort((a, b) => langRank(a) - langRank(b) || a.localeCompare(b));

  const seasons = (m.relations?.edges || [])
    .filter((ed) => ed.node?.type === 'ANIME' && RELATION_TYPES.includes(ed.relationType))
    .map((ed) => ({
      id: ed.node.id,
      relation: ed.relationType,
      title: ed.node.title.english || ed.node.title.romaji || '',
      year: ed.node.seasonYear || null,
      format: ed.node.format || '',
      cover: ed.node.coverImage?.large || ''
    }));

  const streamingLinks = (m.externalLinks || [])
    .filter((l) => l.type === 'STREAMING' && l.url)
    .map((l) => ({ site: l.site || 'Stream', url: l.url, color: l.color || '', language: l.language || '' }));

  return {
    id: m.id,
    idMal: m.idMal || null,
    siteUrl: m.siteUrl || '',
    /* English first; romaji next; the native script only when there is
       nothing else — better a title you can't read than no title. */
    title: m.title.english || m.title.romaji || m.title.native || '?',
    romaji: m.title.romaji || '',
    native: m.title.native || '',
    description: cleanDescription(m.description),
    format: m.format || '',
    status: m.status || '',
    season: m.season || '',
    year: m.seasonYear || null,
    episodes: m.episodes || null,
    duration: m.duration || null,
    genres: m.genres || [],
    tags: pickTags(m.tags),
    score: m.averageScore || null,
    popularity: m.popularity || null,
    cover: m.coverImage.extraLarge || m.coverImage.large || '',
    coverColor: m.coverImage.color || '',
    banner: m.bannerImage || '',
    studios: (m.studios?.nodes || []).map((n) => n.name),
    nextAiring: m.nextAiringEpisode
      ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt }
      : null,
    trailer: m.trailer?.site === 'youtube' && m.trailer.id ? { id: m.trailer.id } : null,
    episodeSource: 'partial',
    epv: 0,
    epSources: anilistEps.length ? 'ANILIST' : 'NONE',
    episodesList: eps,
    seasons,
    dubLanguages,
    streamingLinks,
    sources: [],
    addedAt: Date.now(),
    fetchedAt: Date.now()
  };
}

/* Fetch everything about one show and shape it into a library record.
   opts.franchise:false skips the (expensive) franchise graph crawl —
   used when peeking at a season from within an existing show page. */
async function enrichShow(mediaId, opts = {}) {
  const m = await fetchDetail(mediaId);

  const anilistEps = (m.streamingEpisodes || []).map((e) => {
    const match = /episode\s*(\d+)/i.exec(e.title || '');
    return {
      number: match ? +match[1] : null,
      title: e.title || '',
      thumbnail: e.thumbnail || '',
      url: e.url || '',
      site: e.site || ''
    };
  });

  let jikanRows = [];
  let kitsu = { count: 0, map: new Map() };
  let tvdb = new Map();
  if (m.idMal) {
    jikanRows = await fetchJikanEpisodes(m.idMal);
    /* Jikan is per-AniList-entry, so its episode 1 air date identifies which
       slice of the TVDB season this entry actually is. */
    tvdb = await fetchTvdbEpisodes(m.idMal, jikanRows.find((r) => r.number === 1)?.aired || null);
    kitsu = tvdb.size >= (m.episodes || 1) ? kitsu : await fetchKitsuEpisodes(m.idMal);
  }
  const eps = mergeEpisodes(m.episodes, anilistEps, jikanRows, kitsu, tvdb);
  const epSources = [
    tvdb.size ? 'TVDB' : null,
    jikanRows.length ? 'MAL' : null,
    kitsu.map.size ? 'KITSU' : null,
    anilistEps.length ? 'ANILIST' : null
  ].filter(Boolean).join(' + ') || 'NONE';

  const langRank = (l) => (l === 'Japanese' ? 0 : l === 'English' ? 1 : 2);
  const dubLanguages = [...new Set(
    (m.characters?.edges || [])
      .flatMap((ed) => (ed.voiceActors || []).map((v) => v.languageV2))
      .filter(Boolean)
  )].sort((a, b) => langRank(a) - langRank(b) || a.localeCompare(b));

  const seasons = (m.relations?.edges || [])
    .filter((ed) => ed.node?.type === 'ANIME' && RELATION_TYPES.includes(ed.relationType))
    .map((ed) => ({
      id: ed.node.id,
      relation: ed.relationType,
      title: ed.node.title.english || ed.node.title.romaji || '',
      year: ed.node.seasonYear || null,
      format: ed.node.format || '',
      cover: ed.node.coverImage?.large || ''
    }));

  const streamingLinks = (m.externalLinks || [])
    .filter((l) => l.type === 'STREAMING' && l.url)
    .map((l) => ({ site: l.site || 'Stream', url: l.url, color: l.color || '', language: l.language || '' }));

  let franchise = [];
  if (opts.franchise !== false) {
    try {
      franchise = await fetchFranchise(m.id);
    } catch {
      /* fall back to the one-hop `seasons` list below */
    }
  }

  return {
    id: m.id,
    idMal: m.idMal || null,
    siteUrl: m.siteUrl || '',
    /* English first; romaji next; the native script only when there is
       nothing else — better a title you can't read than no title. */
    title: m.title.english || m.title.romaji || m.title.native || '?',
    romaji: m.title.romaji || '',
    native: m.title.native || '',
    description: cleanDescription(m.description),
    format: m.format || '',
    status: m.status || '',
    season: m.season || '',
    year: m.seasonYear || null,
    episodes: m.episodes || null,
    duration: m.duration || null,
    genres: m.genres || [],
    tags: pickTags(m.tags),
    score: m.averageScore || null,
    popularity: m.popularity || null,
    cover: m.coverImage.extraLarge || m.coverImage.large || '',
    coverColor: m.coverImage.color || '',
    banner: m.bannerImage || '',
    studios: (m.studios?.nodes || []).map((n) => n.name),
    nextAiring: m.nextAiringEpisode
      ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt }
      : null,
    trailer: m.trailer?.site === 'youtube' && m.trailer.id ? { id: m.trailer.id } : null,
    episodeSource: 'merged',
    epv: EP_VERSION,
    epSources,
    episodesList: eps,
    seasons,
    franchise,
    frv: franchise ? 4 : undefined, // 4 = relation types + English-first titles
    dubLanguages,
    streamingLinks,
    sources: [],
    addedAt: Date.now(),
    fetchedAt: Date.now()
  };
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
const TRACE_URL = 'https://api.trace.moe/search';
const TRACE_CONFIDENT = 0.87;
const TRACE_PLAUSIBLE = 0.7;

function traceConfidence(similarity) {
  if (similarity >= TRACE_CONFIDENT) return 'match';
  if (similarity >= TRACE_PLAUSIBLE) return 'maybe';
  return 'unlikely';
}

/* `input` is either a URL string or a Blob/File/ArrayBuffer of image data */
async function traceMoeSearch(input, apiKey) {
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
function traceStamp(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Cover art + meta for a set of ids, so an identify result can be rendered as
   a normal search row rather than a bare scene thumbnail. One batched query. */
/* Exact start dates for announced entries.
   The franchise walk only keeps year + month, which is enough to sort by but
   not enough to say "14 Oct 2026". This asks for the full startDate and the
   airing slot, so a confirmed premiere shows a real date and a vague one is
   honestly labelled instead of being invented. */
async function fetchUpcoming(ids) {
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
    /* a date is only "confirmed" when the day is actually known */
    const at = d.year && d.month && d.day
      ? new Date(d.year, d.month - 1, d.day).getTime()
      : (m.nextAiringEpisode?.airingAt ? m.nextAiringEpisode.airingAt * 1000 : null);
    out.set(m.id, {
      at,
      day: d.day || null,
      episodes: m.episodes || null,
      format: m.format || '',
      status: m.status || '',
      cover: m.coverImage?.large || '',
      fetchedAt: Date.now()
    });
  }
  return out;
}

async function fetchBasics(ids) {
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
async function fetchTraceQuota(apiKey) {
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

/* ——— browse: query AniList directly rather than filtering the shelf ———
   Two vocabularies matter here and they are easy to conflate. There are 19
   GENRES (Comedy, Romance, Ecchi…) and 425 TAGS in 24 categories (Female
   Harem, Iyashikei…), and what a person calls "tags" spans both — "harem"
   is three separate tags, none of them a genre. Callers pass whichever and
   this sorts them out.

   Verified against the live API: genre_in and tag_in are both AND, and they
   AND with each other too, so a multi-select narrows exactly as expected
   with no client-side filtering. pageInfo.total caps at 5000, so it is
   reported as a floor, never as a count. */
const BROWSE_QUERY = `
query ($page: Int, $genres: [String], $tags: [String], $formats: [MediaFormat],
       $season: MediaSeason, $year: Int, $status: MediaStatus, $sort: [MediaSort],
       $minScore: Int, $adult: Boolean, $search: String) {
  Page(page: $page, perPage: 30) {
    pageInfo { currentPage hasNextPage total }
    media(type: ANIME, genre_in: $genres, tag_in: $tags, format_in: $formats,
          season: $season, seasonYear: $year, status: $status, sort: $sort,
          averageScore_greater: $minScore, isAdult: $adult, search: $search) {
      id idMal
      title { romaji english native }
      format status season seasonYear episodes duration
      averageScore popularity genres
      tags { name rank isGeneralSpoiler }
      coverImage { extraLarge large color }
      bannerImage
      description(asHtml: false)
      studios(isMain: true) { nodes { name } }
      nextAiringEpisode { episode airingAt }
      # No dub filter exists in the API: an English dub is only knowable by
      # asking whether any character has an English voice actor, which is why
      # "dubbed" can only ever be applied to rows already fetched.
      # (GraphQL comments are #, not /* */ — a block comment here 400s.)
      # The node selection is NOT optional here. Without it AniList returns
      # voiceActors: null for every edge, so nothing looks dubbed —
      # verified both ways: 0/6 without node, 6/6 with it.
      characters(perPage: 4, sort: ROLE) {
        edges { node { id } voiceActors(language: ENGLISH) { id } }
      }
    }
  }
}`;

async function browseAnime(f = {}, page = 1) {
  const vars = { page, sort: f.sort || ['POPULARITY_DESC'] };
  if (f.genres?.length) vars.genres = f.genres;
  if (f.tags?.length) vars.tags = f.tags;
  if (f.formats?.length) vars.formats = f.formats;
  if (f.season) vars.season = f.season;
  if (f.year) vars.year = Number(f.year);
  if (f.status) vars.status = f.status;
  if (f.minScore) vars.minScore = Number(f.minScore) - 1;   // _greater is exclusive
  if (f.search) vars.search = f.search;
  /* Leave isAdult unset to get AniList's default (adult excluded). Passing
     false is NOT the same as omitting it on some filter combinations. */
  if (f.adult) vars.adult = true;

  const d = await gql(BROWSE_QUERY, vars, { bg: false });   // someone is waiting on this
  const p = d.Page;
  return {
    page: p.pageInfo.currentPage,
    hasNext: p.pageInfo.hasNextPage,
    atLeast: p.pageInfo.total,          // capped at 5000 by AniList — a floor, not a count
    media: p.media || []
  };
}

/* The two vocabularies, fetched once and cached for the session. Genres are a
   flat 19; tags come with a category so the 425 can be grouped instead of
   dumped in one list nobody can scan. */
let vocabCache = null;
async function fetchFilterVocab() {
  if (vocabCache) return vocabCache;
  const d = await gql(`{ GenreCollection MediaTagCollection { name description category isAdult } }`,
    {}, { bg: false });
  const tags = (d.MediaTagCollection || []).filter((t) => t.category);
  const byCat = new Map();
  for (const t of tags) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  for (const list of byCat.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  vocabCache = {
    genres: (d.GenreCollection || []).filter((g) => g !== 'Hentai'),
    tags,
    categories: [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  };
  return vocabCache;
}
