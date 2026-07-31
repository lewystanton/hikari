/* On-device enrichment — a faithful port of the desktop pipeline
   (src/api.js): franchise BFS over AniList relations, the epv-5 episode
   merge (Jikan canon + Kitsu synopses/thumbs + TVDB stills), and the
   artwork pools.

   This is what makes the phone a first-class client rather than a viewer for
   whatever a desktop happened to sync in: everything the desktop can build,
   it builds here too, from the phone.

   CORS-blocked hosts (arm.haglund.dev, skyhook.sonarr.tv, animeschedule.net)
   go through CapacitorHttp — native requests don't care about CORS. Only the
   browser preview skips those steps. */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { gql } from './api.js';

export const isNative = () => Capacitor.isNativePlatform();
const jsleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* `ms` bounds the slow providers. CapacitorHttp takes its own timeouts and
   ignores an AbortSignal entirely, so the two transports need it expressed
   differently — passing a signal here would have been silently inert. */
async function xjson(url, ms = 0) {
  try {
    if (isNative()) {
      const res = await CapacitorHttp.get({
        url, headers: { Accept: 'application/json' },
        connectTimeout: ms ? Math.min(ms, 15000) : 15000,
        readTimeout: ms || 25000
      });
      if (res.status < 200 || res.status >= 300) return null;
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    }
    const r = await fetch(url, { headers: { Accept: 'application/json' },
      signal: ms && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/* ——— franchise graph (desktop fetchFranchise, verbatim logic) ——— */
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
      id format status seasonYear
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
const EXPAND_RELS = ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT', 'SUMMARY', 'ALTERNATIVE'];
const INCLUDE_RELS = [...EXPAND_RELS, 'SPIN_OFF'];
const FRANCHISE_CAP = 40;

export async function fetchFranchise(rootId) {
  const seen = new Set([rootId]);
  const relMap = new Map();
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
        if (EXPAND_RELS.includes(ed.relationType)) next.push(n.id);
      }
    }
    frontier = next;
  }
  const ids = [...seen];

  /* The BFS only asked the frontier for relations, so leaves have none. Fill
     the gaps — the relation TYPES are what separate a sequel from a reboot,
     and without them every entry looks equally related to every other. */
  const unknown = ids.filter((id) => !relMap.has(id));
  for (let i = 0; i < unknown.length; i += 50) {
    try {
      const d = await gql(REL_BATCH_QUERY, { ids: unknown.slice(i, i + 50) }, { bg: true });
      for (const m of d.Page.media || []) {
        relMap.set(m.id, (m.relations?.edges || [])
          .filter((e) => e.node?.type === 'ANIME')
          .map((e) => [e.node.id, e.relationType]));
      }
    } catch { /* partial relations beat none */ }
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
      rel: (relMap.get(m.id) || []).filter(([other]) => seen.has(other))
    }))
    .sort((a, b) => a.sort - b.sort);
  /* English first, and honestly. AniList leaves `title.english` null on many
     specials and unaired seasons. Two safe recoveries, then plain fallbacks:
     (A) reuse a sibling's English for a matching romaji prefix; (B) trust a
     synonym only when it CONTAINS a sibling's English title — that is what
     separates the real English name ("The Testament of Sister New Devil BURST
     Specials") from a literal gloss (Sekirei -> "Wagtail") or a renumbering
     (High School DxD NEW -> "High School DxD 2"). Keep in step with desktop. */
  const withEn = mapped.filter((x) => x.en && x.romaji);
  const isLatin = (t) => !/[぀-ヿ㐀-䶿一-鿿가-힯]/.test(t || '');
  for (const x of mapped) {
    if (x.en) { x.title = x.en; continue; }
    let best = null;
    for (const w of withEn) {
      if (w.id !== x.id && x.romaji.startsWith(w.romaji) && (!best || w.romaji.length > best.romaji.length)) best = w;
    }
    if (best) { x.title = best.en + x.romaji.slice(best.romaji.length); continue; }
    const vouched = (x.syn || [])
      .filter(isLatin)
      .filter((cand) => withEn.some((w) => w.id !== x.id && w.en.length > 6
        && cand.toLowerCase().includes(w.en.toLowerCase())))
      .sort((a, c) => c.length - a.length)[0];
    x.title = vouched || x.romaji || x.native || '';
  }
  return mapped.map(({ en, romaji, syn, ...rest }) => rest);
}

/* ——— episode sources (desktop ports) ——— */
async function fetchJikanEpisodes(malId) {
  if (!malId) return [];
  const out = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const json = await xjson(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`);
      if (!json) break;
      out.push(...(json.data || []).map((e) => ({
        number: e.mal_id, title: e.title || `Episode ${e.mal_id}`,
        aired: e.aired ? e.aired.slice(0, 10) : '',
        filler: !!e.filler, recap: !!e.recap, score: e.score ?? null
      })));
      if (!json.pagination?.has_next_page) break;
      await jsleep(360);
    }
  } catch { /* partial is fine */ }
  return out;
}

async function fetchKitsuEpisodes(malId) {
  const empty = { count: 0, map: new Map() };
  if (!malId) return empty;
  try {
    const mjson = await xjson(`https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`);
    const kitsuId = mjson?.included?.[0]?.id;
    if (!kitsuId) return empty;
    const map = new Map();
    let count = 0;
    for (let offset = 0; offset < 160; offset += 20) {
      const json = await xjson(`https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=20&page[offset]=${offset}&sort=number`);
      if (!json?.data?.length) break;
      count = json.meta?.count || count;
      for (const e of json.data) {
        const a = e.attributes || {};
        if (a.number != null && !map.has(a.number)) {
          map.set(a.number, {
            title: a.canonicalTitle || '', thumbnail: a.thumbnail?.original || '',
            aired: a.airdate || '', synopsis: a.synopsis || '', length: a.length || null
          });
        }
      }
      if (!json.links?.next) break;
      await jsleep(220);
    }
    return { count, map };
  } catch { return empty; }
}

async function fetchTvdbEpisodes(malId, firstAired = null) {
  const empty = new Map();
  if (!malId || !isNative()) return empty;    // no-CORS host — device only
  try {
    const arm = await armIds(malId);       // shared cache with the art pool
    const tvdbId = arm?.thetvdb;
    if (!tvdbId) return empty;
    const season = Number.isInteger(arm['thetvdb-season']) && arm['thetvdb-season'] > 0 ? arm['thetvdb-season'] : 1;
    const show = await xjson(`https://skyhook.sonarr.tv/v1/tvdb/shows/en/${tvdbId}`);
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
          title: e.title || '', thumbnail: e.image || '',
          aired: e.airDate || '', overview: e.overview || '',
          absolute: e.absoluteEpisodeNumber || null
        });
      }
    }
    return map;
  } catch { return empty; }
}

export async function fetchDubSchedule(idMal) {
  if (!idMal || !isNative()) return null;     // no-CORS host — device only
  const j = await xjson(`https://animeschedule.net/api/v3/anime?mal-ids=${idMal}`);
  const a = (j?.anime || (Array.isArray(j) ? j : []))[0];
  if (!a) return null;
  const iso = (v) => (v && !String(v).startsWith('0001-') ? v : null);
  return {
    dubPremier: iso(a.dubPremier), dubTime: iso(a.dubTime),
    subTime: iso(a.subTime), jpnTime: iso(a.jpnTime),
    dubDelayedFrom: iso(a.dubDelayedFrom), dubDelayedUntil: iso(a.dubDelayedUntil),
    route: a.route || ''
  };
}

/* ——— the epv-5 merge (desktop mergeEpisodes, verbatim) ——— */
function mergeEpisodes(totalHint, anilistEps, jikanRows, kitsu, tvdb = new Map()) {
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
  let anEps = anilistEps.filter((e) => e.number != null);
  if (canonical && anEps.length) {
    const min = Math.min(...anEps.map((e) => e.number));
    const max = Math.max(...anEps.map((e) => e.number));
    if (min > 1 || max > canonical) {
      const offset = min - 1;
      anEps = anEps.map((e) => ({ ...e, number: e.number - offset }))
        .filter((e) => e.number >= 1 && e.number <= canonical);
    }
  }
  const anMap = new Map();
  for (const e of anEps) if (!anMap.has(e.number)) anMap.set(e.number, e);
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
    const titleOrder = jikanSuspect ? [t?.title, k?.title, j?.title] : [j?.title, t?.title, k?.title];
    const airedOrder = jikanSuspect ? [t?.aired, k?.aired, j?.aired] : [j?.aired, t?.aired, k?.aired];
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

/* ——— artwork pools (port of desktop fetchArtPool) ———
   Ported so the phone builds its own galleries instead of waiting for a
   desktop to sync one in. The keys ride the account's settings row and can be
   set from either app. With neither key set this still gathers AniList,
   Jikan, Kitsu and TVDB art — just fewer, lower-resolution options. */
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
const armCache = new Map();
const tvdbShowCache = new Map();

async function armIds(malId) {
  if (armCache.has(malId)) return armCache.get(malId);
  const j = await xjson(`https://arm.haglund.dev/api/v2/ids?source=myanimelist&id=${malId}`);
  armCache.set(malId, j);
  return j;
}

async function fetchTmdbImages(malId, key) {
  const out = { covers: [], banners: [] };
  if (!key || !malId) return out;
  try {
    const arm = await armIds(malId);
    const tmdbId = arm?.themoviedb;
    if (!tmdbId) return out;
    const media = arm?.media === 'MOVIE' ? 'movie' : 'tv';
    const imgs = await xjson(`https://api.themoviedb.org/3/${media}/${tmdbId}/images?api_key=${encodeURIComponent(key)}`);
    for (const p of imgs?.posters || []) out.covers.push(`${TMDB_IMG}w500${p.file_path}`);
    /* backdrops become full-bleed heroes — originals, not w1280 */
    for (const b of imgs?.backdrops || []) out.banners.push(`${TMDB_IMG}original${b.file_path}`);
    if (media === 'tv') {
      const detail = await xjson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(key)}`);
      const nums = (detail?.seasons || []).map((x) => x.season_number)
        .filter((n) => Number.isInteger(n) && n > 0).slice(0, 8);
      if (!nums.length) nums.push(1);
      for (const n of nums) {
        const s = await xjson(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${n}/images?api_key=${encodeURIComponent(key)}`);
        for (const p of s?.posters || []) out.covers.push(`${TMDB_IMG}w500${p.file_path}`);
      }
    }
  } catch { /* no tmdb art */ }
  return out;
}

async function fetchFanartImages(malId, key) {
  const out = { covers: [], banners: [] };
  if (!key || !malId) return out;
  try {
    const arm = await armIds(malId);
    if (!arm?.thetvdb) return out;
    const data = await xjson(`https://webservice.fanart.tv/v3/tv/${arm.thetvdb}?api_key=${encodeURIComponent(key)}`);
    if (!data) return out;
    for (const p of data.tvposter || []) out.covers.push(p.url);
    for (const p of data.seasonposter || []) out.covers.push(p.url);
    for (const b of data.showbackground || []) out.banners.push(b.url);
    for (const b of data.tvbanner || []) out.banners.push(b.url);
  } catch { /* no fanart */ }
  return out;
}

const ART_POOL_QUERY =
  'query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id idMal coverImage{extraLarge large} bannerImage}}}';

/* Same shape as the desktop's src/api.js — see the note there. Six providers
   awaited in turn, most of the wall clock spent waiting on nothing, and the
   AniList leg queued behind whatever crawl was already running. They are
   independent, so run them together; only Jikan chains, off the MAL ids the
   AniList query returns. Reassembled in provider order because position in
   covers/banners IS the preference order. */
const ART_TIMEOUT = 8000;
const cappedArt = (p) => Promise.race([
  p, new Promise((res) => setTimeout(() => res({ covers: [], banners: [] }), ART_TIMEOUT + 4000))
]).catch(() => ({ covers: [], banners: [] }));

export async function fetchArtPool(anilistIds, malId, keys = {}, { bg = true } = {}) {
  const empty = { covers: [], banners: [] };

  const pTmdb = keys.tmdb ? cappedArt(fetchTmdbImages(malId, keys.tmdb)) : Promise.resolve(empty);
  const pFanart = keys.fanart ? cappedArt(fetchFanartImages(malId, keys.fanart)) : Promise.resolve(empty);

  const pAni = cappedArt((async () => {
    const covers = [], banners = [], jikan = [];
    const d = await gql(ART_POOL_QUERY, { ids: anilistIds.slice(0, 50) }, { bg });
    const media = d.Page.media || [];
    for (const m of media) {
      const c = m.coverImage?.extraLarge || m.coverImage?.large;
      if (c) covers.push(c);
      if (m.bannerImage) banners.push(m.bannerImage);
    }
    /* three at once with a hard timeout, rather than five in series with a
       1200ms backoff and a 500ms gap — /pictures 504s on a cold cache and
       the retry used to cost a full connection timeout */
    const malIds = media.map((m) => m.idMal).filter(Boolean).slice(0, 3);
    await Promise.all(malIds.map(async (id) => {
      const j = await xjson(`https://api.jikan.moe/v4/anime/${id}/pictures`, ART_TIMEOUT);
      for (const p of (j?.data || [])) {
        const u = p.jpg?.large_image_url || p.jpg?.image_url;
        if (u) jikan.push(u);
      }
    }));
    return { covers: [...covers, ...jikan], banners };
  })());

  const pKitsu = cappedArt((async () => {
    const covers = [], banners = [];
    const m = await xjson(`https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`, ART_TIMEOUT);
    const at = m?.included?.[0]?.attributes;
    if (at?.posterImage?.original) covers.push(at.posterImage.original);
    if (at?.coverImage?.original) banners.push(at.coverImage.original);
    return { covers, banners };
  })());

  const pTvdb = cappedArt((async () => {
    const covers = [], banners = [];
    const arm = await armIds(malId);
    if (arm?.thetvdb) {
      let show = tvdbShowCache.get(arm.thetvdb);
      if (!show) {
        show = await xjson(`https://skyhook.sonarr.tv/v1/tvdb/shows/en/${arm.thetvdb}`);
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

  const parts = await Promise.all([pTmdb, pFanart, pAni, pKitsu, pTvdb]);
  const covers = parts.flatMap((p) => p?.covers || []);
  const banners = parts.flatMap((p) => p?.banners || []);
  return { covers: [...new Set(covers)], banners: [...new Set(banners)] };
}

/* ——— entry point: take a lite record, return the finished one ———
   User-owned fields ride through untouched (spread base). On device every
   source is reachable, so the record comes out at full strength (epv 5,
   frv 2) — identical to what the desktop produces, and needing nothing from
   it. The browser preview can't reach the CORS-blocked hosts, so it stays at
   epv 0 and will be finished by whichever real client opens it next. */
export async function enrichRecord(rec) {
  const native = isNative();
  const franchise = await fetchFranchise(rec.id);
  const anilistEps = (rec.episodesList || [])
    .filter((e) => e.url || e.thumbnail)
    .map((e) => ({ number: e.number ?? e.n, title: e.title || '', thumbnail: e.thumbnail || '', url: e.url || '', site: e.site || '' }));
  const jikan = await fetchJikanEpisodes(rec.idMal);
  const kitsu = await fetchKitsuEpisodes(rec.idMal);
  /* Jikan is per-AniList-entry, so its episode 1 air date identifies which
     slice of the TVDB season this entry actually is (a split cour is one
     season on TVDB and two entries on AniList). */
  const tvdb = await fetchTvdbEpisodes(rec.idMal, jikan.find((r) => r.number === 1)?.aired || null);
  const rows = mergeEpisodes(rec.episodes, anilistEps, jikan, kitsu, tvdb);
  let dubSched = rec.dubSched || null;
  if (rec.status === 'RELEASING') dubSched = (await fetchDubSchedule(rec.idMal)) || dubSched;
  return {
    ...rec,
    franchise,
    episodesList: rows.length ? rows : rec.episodesList,
    episodeSource: rows.length ? 'merged' : rec.episodeSource,
    epSources: ['JIKAN', kitsu.map.size && 'KITSU', tvdb.size && 'TVDB'].filter(Boolean).join('+') || rec.epSources,
    /* Keep in lock-step with EP_VERSION in the desktop src/api.js. If the
       phone writes an older number the desktop re-enriches everything it
       touches, and if it writes a newer one the desktop stops fixing real
       staleness. Mobile carries the same split-cour alignment. */
    epv: native ? 6 : 0,
    frv: 4,                      // franchise entries carry per-season dub flags
    ...(dubSched ? { dubSched } : {}),
    fetchedAt: Date.now()
  };
}

/* ——— "more like this" ———
   AniList carries per-show recommendations ranked by community rating, which
   is a real "people who liked this" list rather than a genre intersection
   standing in for one. Mirrors the desktop fetchRecommendations, narrowed to
   one show since the phone only ever asks about the page you are on. */
const RECS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    recommendations(perPage: 12, sort: RATING_DESC) {
      nodes {
        mediaRecommendation {
          id
          title { romaji english }
          format
          seasonYear
          coverImage { large }
        }
      }
    }
  }
}`;

export async function fetchShowRecs(mediaId) {
  const d = await gql(RECS_QUERY, { id: mediaId }, { bg: false });
  return (d?.Media?.recommendations?.nodes || [])
    .map((n) => n?.mediaRecommendation)
    .filter(Boolean)
    .map((m) => ({
      id: m.id,
      title: m.title.english || m.title.romaji || '?',
      year: m.seasonYear || null,
      format: m.format || '',
      cover: m.coverImage?.large || ''
    }));
}

/* ——— browse ———
   Mirrors the desktop src/api.js. Two vocabularies matter: 19 genres and 425
   tags in 24 categories, and what a person calls "tags" spans both — harem is
   three tags and no genre. genre_in and tag_in are both AND, and AND with
   each other, so a multi-select narrows with no client-side filtering.
   AniList clamps perPage at 50 silently, so larger sizes chain requests. */
const BROWSE_QUERY = `
query ($page: Int, $perPage: Int, $genres: [String], $tags: [String],
       $formats: [MediaFormat], $status: MediaStatus, $sort: [MediaSort],
       $minScore: Int, $adult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { currentPage hasNextPage }
    media(type: ANIME, genre_in: $genres, tag_in: $tags, format_in: $formats,
          status: $status, sort: $sort, averageScore_greater: $minScore, isAdult: $adult) {
      id idMal
      title { romaji english }
      format status seasonYear episodes averageScore
      coverImage { large color }
      # node is NOT optional — without it AniList returns voiceActors: null
      # for every edge, so nothing looks dubbed.
      characters(perPage: 4, sort: ROLE) {
        edges { node { id } voiceActors(language: ENGLISH) { id } }
      }
    }
  }
}`;

export async function browseAnime(f = {}, page = 1, perPage = 50) {
  const vars = { page, perPage: Math.min(perPage, 50), sort: f.sort || ['POPULARITY_DESC'] };
  if (f.genres?.length) vars.genres = f.genres;
  if (f.tags?.length) vars.tags = f.tags;
  if (f.formats?.length) vars.formats = f.formats;
  if (f.status) vars.status = f.status;
  if (f.minScore) vars.minScore = Number(f.minScore) - 1;
  if (f.adult) vars.adult = true;          // omitting it keeps AniList's default
  const d = await gql(BROWSE_QUERY, vars, { bg: false });
  return { page: d.Page.pageInfo.currentPage, hasNext: d.Page.pageInfo.hasNextPage, media: d.Page.media || [] };
}

let vocabCache = null;
export async function fetchFilterVocab() {
  if (vocabCache) return vocabCache;
  const d = await gql(`{ GenreCollection MediaTagCollection { name category isAdult } }`, {}, { bg: false });
  const tags = (d.MediaTagCollection || []).filter((t) => t.category);
  const byCat = new Map();
  for (const t of tags) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  for (const l of byCat.values()) l.sort((a, b) => a.name.localeCompare(b.name));
  vocabCache = {
    genres: (d.GenreCollection || []).filter((g) => g !== 'Hentai'),
    tags,
    categories: [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  };
  return vocabCache;
}
