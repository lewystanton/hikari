/* Data layer: Supabase auth + library rows, IndexedDB cache, realtime.
   Same table + merge semantics as the desktop sync engine (src/sync.js):
   remote wins, watched lists union, per-row hash meta for diffing. */
import { createClient } from '@supabase/supabase-js';
import { SUPA_URL, SUPA_ANON } from './config.js';

export const supa = createClient(SUPA_URL, SUPA_ANON, {
  auth: { persistSession: true, autoRefreshToken: true }
});

/* —— tiny IndexedDB kv —— */
const idb = new Promise((res, rej) => {
  const req = indexedDB.open('hikari-mobile', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
async function kvGet(key) {
  const db = await idb;
  return new Promise((res) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(undefined);
  });
}
async function kvSet(key, val) {
  const db = await idb;
  return new Promise((res) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = res;
    tx.onerror = res;
  });
}

/* —— state —— */
/* The API keys this app can use. They live in the account's settings row so
   they follow you between devices, and EITHER app may set them — which is why
   writes merge into the row rather than replacing it (see saveKeys). */
export const KEY_FIELDS = ['tmdbKey', 'fanartKey', 'traceKey'];
let cloudSettings = {};        // last seen copy of the whole row, for merging

export const state = {
  user: null,
  library: [],          // array of records (same shape as desktop, no `local`)
  meta: {},             // mediaId -> { h, t }
  lastSync: 0,
  remote: null,         // {addr, token} — OPTIONAL desktop LAN server for local video
  keys: { tmdbKey: '', fanartKey: '', traceKey: '' },
  onChange: () => {}    // main.js re-render hook
};

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + s.length;
}
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) =>
    v[k] === undefined ? '' : JSON.stringify(k) + ':' + stableStringify(v[k]))
    .filter(Boolean).join(',') + '}';
}
const recHash = (r) => hash(stableStringify(r));

function unionWatched(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])].sort((x, y) => x - y);
  }
  return out;
}

async function loadCache() {
  state.library = (await kvGet(`lib.${state.user.id}`)) || [];
  state.meta = (await kvGet(`meta.${state.user.id}`)) || {};
  state.lastSync = (await kvGet(`last.${state.user.id}`)) || 0;
  /* keys are cached so artwork still works on a cold, offline start */
  cloudSettings = (await kvGet(`set.${state.user.id}`)) || {};
  for (const k of KEY_FIELDS) state.keys[k] = cloudSettings[k] || '';
}
async function saveCache() {
  await kvSet(`lib.${state.user.id}`, state.library);
  await kvSet(`meta.${state.user.id}`, state.meta);
  await kvSet(`last.${state.user.id}`, state.lastSync);
  await kvSet(`set.${state.user.id}`, cloudSettings);
}

function applyRemote(mediaId, record, updatedAt) {
  const idx = state.library.findIndex((r) => r.id === mediaId);
  const incoming = { ...record };
  if (idx >= 0) {
    const cur = state.library[idx];
    if (recHash(cur) === recHash(incoming)) {
      state.meta[mediaId] = { h: recHash(cur), t: updatedAt };
      return false;
    }
    incoming.watched = unionWatched(cur.watched, incoming.watched);
    state.library[idx] = incoming;
  } else {
    state.library.push(incoming);
  }
  state.meta[mediaId] = { h: recHash(incoming), t: updatedAt };
  return true;
}

/* —— pull (manifest diff, then only changed rows) —— */
let busy = false;
export async function pull() {
  if (!state.user || busy) return 0;
  busy = true;
  let applied = 0;
  try {
    const { data: manifest, error } = await supa.from('library')
      .select('media_id,updated_at').eq('user_id', state.user.id);
    if (error) throw error;
    const remoteIds = new Set();
    const want = [];
    for (const row of manifest || []) {
      remoteIds.add(row.media_id);
      if (!state.meta[row.media_id] || state.meta[row.media_id].t !== row.updated_at) want.push(row.media_id);
    }
    for (let i = 0; i < want.length; i += 25) {
      const { data: rows, error: e2 } = await supa.from('library')
        .select('media_id,record,updated_at')
        .eq('user_id', state.user.id).in('media_id', want.slice(i, i + 25));
      if (e2) throw e2;
      for (const row of rows || []) {
        if (applyRemote(row.media_id, row.record, row.updated_at)) applied++;
      }
    }
    for (const id of Object.keys(state.meta).map(Number)) {
      if (!remoteIds.has(id)) {
        const idx = state.library.findIndex((r) => r.id === id);
        if (idx >= 0) { state.library.splice(idx, 1); applied++; }
        delete state.meta[id];
      }
    }
    /* settings row — the account's shared preferences. API keys can be set
       from EITHER app; the remote-play address is written by whichever
       desktop is publishing one. */
    const { data: srow } = await supa.from('settings')
      .select('data').eq('user_id', state.user.id).maybeSingle();
    cloudSettings = srow?.data || {};
    for (const k of KEY_FIELDS) {
      if ((cloudSettings[k] || '') !== (state.keys[k] || '')) state.keys[k] = cloudSettings[k] || '';
    }
    /* `remoteAddrs` is every LAN address the desktop is listening on; only
       some may be routable from this phone, so keep them all and let the
       probe race them. Older desktops send `remoteAddr` alone. */
    const nextRemote = srow?.data?.remoteAddr && srow?.data?.remoteToken
      ? {
        addr: srow.data.remoteAddr,
        addrs: Array.isArray(srow.data.remoteAddrs) && srow.data.remoteAddrs.length
          ? srow.data.remoteAddrs : [srow.data.remoteAddr],
        token: srow.data.remoteToken
      } : null;
    if (JSON.stringify(nextRemote) !== JSON.stringify(state.remote)) {
      state.remote = nextRemote;
      applied++;                       // force onChange so the UI re-probes the server
    }
    state.lastSync = Date.now();
    await saveCache();
  } catch (e) {
    console.warn('[pull]', e.message || e);
  } finally { busy = false; }
  if (applied) state.onChange();
  return applied;
}

/* remove a whole show (all member records) — desktop realtime-removes too */
export async function removeShow(ids) {
  const { error } = await supa.from('library').delete()
    .eq('user_id', state.user.id).in('media_id', ids);
  if (error) throw error;
  state.library = state.library.filter((r) => !ids.includes(r.id));
  for (const id of ids) delete state.meta[id];
  state.lastSync = Date.now();
  await saveCache();
  state.onChange();
}

/* —— push a single edited record (mobile only edits watched) —— */
const pushTimers = new Map();
export function pushRecord(rec) {
  clearTimeout(pushTimers.get(rec.id));
  pushTimers.set(rec.id, setTimeout(async () => {
    pushTimers.delete(rec.id);
    try {
      const now = new Date().toISOString();
      const { error } = await supa.from('library').upsert({
        user_id: state.user.id, media_id: rec.id, record: rec, updated_at: now
      }, { onConflict: 'user_id,media_id' });
      if (error) throw error;
      state.meta[rec.id] = { h: recHash(rec), t: now };
      state.lastSync = Date.now();
      await saveCache();
    } catch (e) { console.warn('[push]', e.message || e); }
  }, 900));
}

/* —— realtime —— */
let channel = null;
export function subscribe() {
  unsubscribe();
  channel = supa.channel('library-live')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'library', filter: `user_id=eq.${state.user.id}` },
      (payload) => {
        let changed = false;
        if (payload.eventType === 'DELETE') {
          const id = Number(payload.old?.media_id);
          const idx = state.library.findIndex((r) => r.id === id);
          if (idx >= 0) { state.library.splice(idx, 1); changed = true; }
          delete state.meta[id];
        } else if (payload.new) {
          const row = payload.new;
          if (state.meta[row.media_id]?.h === recHash(row.record)) {
            state.meta[row.media_id].t = row.updated_at;
            return;
          }
          changed = applyRemote(row.media_id, row.record, row.updated_at);
        }
        if (changed) { saveCache(); state.onChange(); }
      })
    .subscribe();
}
export function unsubscribe() {
  if (channel) { supa.removeChannel(channel); channel = null; }
}

/* —— add a freshly built record (search/discover add flow) —— */
export async function addShow(rec) {
  if (state.library.some((r) => r.id === rec.id)) return false;
  state.library.push(rec);
  const now = new Date().toISOString();
  const { error } = await supa.from('library').upsert({
    user_id: state.user.id, media_id: rec.id, record: rec, updated_at: now
  }, { onConflict: 'user_id,media_id' });
  if (error) {
    state.library = state.library.filter((r) => r.id !== rec.id);
    throw error;
  }
  state.meta[rec.id] = { h: recHash(rec), t: now };
  state.lastSync = Date.now();
  await saveCache();
  state.onChange();
  return true;
}

/* Write API keys back to the account.

   MERGE, never replace. The desktop app keeps far more in this row than the
   phone knows about (window state, media roots policy, its own remote-play
   address), so writing `state.keys` wholesale would silently delete all of
   it. Re-read first so a key set on the desktop a moment ago isn't clobbered
   by a stale copy. */
export async function saveKeys(next) {
  const { data: srow } = await supa.from('settings')
    .select('data').eq('user_id', state.user.id).maybeSingle();
  const base = srow?.data || cloudSettings || {};
  const merged = { ...base };
  for (const k of KEY_FIELDS) {
    if (!(k in next)) continue;             // caller sends only what changed
    const v = String(next[k] || '').trim();
    if (v) merged[k] = v; else delete merged[k];
    state.keys[k] = v;
  }
  /* whatever we weren't asked to change keeps the freshly-read value, so a
     key the other app set thirty seconds ago is never collateral damage */
  for (const k of KEY_FIELDS) if (!(k in next)) state.keys[k] = base[k] || '';
  const { error } = await supa.from('settings')
    .upsert({ user_id: state.user.id, data: merged, updated_at: new Date().toISOString() });
  if (error) throw error;
  cloudSettings = merged;
  await saveCache();
  state.onChange();
}

/* —— tiny cache surface for screens (discover pool etc.) —— */
export const cacheGet = kvGet;
export const cacheSet = kvSet;

/* —— light AniList fetch for seasons never opened on desktop ——
   (peek entries sync from desktop fully enriched; this covers the rest) */
const liteCache = new Map();
export async function fetchSeasonLite(id) {
  if (liteCache.has(id)) return liteCache.get(id);
  const cached = await kvGet(`lite.${id}`);
  if (cached) { liteCache.set(id, cached); return cached; }
  const q = `query($id:Int){Media(id:$id){id format status description(asHtml:false)
    seasonYear episodes coverImage{extraLarge color} bannerImage
    title{userPreferred} nextAiringEpisode{episode airingAt}
    streamingEpisodes{title thumbnail}}}`;
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { id } })
  });
  const m = (await res.json())?.data?.Media;
  if (!m) throw new Error('AniList lookup failed');
  const streams = (m.streamingEpisodes || []).slice().reverse();
  const total = m.episodes || streams.length ||
    (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0);
  const eps = Array.from({ length: Math.max(total, streams.length) }, (_, i) => ({
    number: i + 1,
    title: streams[i]?.title?.replace(/^Episode\s*\d+\s*[-–:]\s*/i, '') || `Episode ${i + 1}`,
    thumbnail: streams[i]?.thumbnail || null,
    aired: '', filler: false
  }));
  const rec = {
    id: m.id, lite: true,
    title: m.title?.userPreferred || `#${id}`,
    format: m.format, status: m.status, year: m.seasonYear,
    cover: m.coverImage?.extraLarge, coverColor: m.coverImage?.color,
    banner: m.bannerImage, description: m.description,
    episodes: m.episodes || null,
    nextAiring: m.nextAiringEpisode
      ? { episode: m.nextAiringEpisode.episode, airingAt: m.nextAiringEpisode.airingAt } : null,
    episodesList: eps
  };
  liteCache.set(id, rec);
  kvSet(`lite.${id}`, rec);
  return rec;
}

/* —— session bootstrap —— */
export async function initAuth(onUser) {
  supa.auth.onAuthStateChange(async (_ev, session) => {
    const next = session?.user || null;
    if (next?.id === state.user?.id) { state.user = next; return; }
    state.user = next;
    if (next) {
      await loadCache();
      subscribe();
      onUser(true);
      pull();
      setInterval(pull, 5 * 60 * 1000);
    } else {
      unsubscribe();
      state.library = []; state.meta = {};
      onUser(false);
    }
  });
  const { data } = await supa.auth.getSession();
  if (!data.session) onUser(false);
}
