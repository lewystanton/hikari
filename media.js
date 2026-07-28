/* Hikari — local media engine (main process).
   Folder scanning, ffprobe, direct-play detection, ffmpeg remux/transcode with
   English-audio preference, subtitle extraction, and a capped playback cache.
   Files reach the sandboxed renderer through the hikari-media:// protocol,
   which only serves paths inside linked roots or the cache. */
'use strict';

const { protocol, ipcMain, dialog, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

/* packaged builds run binaries from the unpacked asar mirror */
const unpack = (p) => String(p).replace('app.asar', 'app.asar.unpacked');
const FFMPEG = unpack(require('ffmpeg-static'));
const FFPROBE = unpack(require('ffprobe-static').path);

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.webm', '.ts', '.m2ts', '.wmv', '.flv', '.ogm', '.mpg', '.mpeg']);
const CACHE_CAP = 10 * 1024 * 1024 * 1024; // 10 GB
const MIN_BYTES = +process.env.HIKARI_MIN_VIDEO_BYTES || 20 * 1024 * 1024;

let allowedRoots = [];
let getWin = () => null;
const jobs = new Map(); // epKey -> child process

const cacheDir = () => path.join(app.getPath('userData'), 'media-cache');
const norm = (p) => path.normalize(p);
const inside = (child, parent) =>
  norm(child).toLowerCase().startsWith(norm(parent).toLowerCase().replace(/[\\/]+$/, '') + path.sep);

function pathAllowed(p) {
  const n = norm(p);
  if (inside(n, cacheDir())) return true;
  return allowedRoots.some((r) => r && inside(n, r));
}

/* URL shape: hikari-media://v/<base64url(directory)>/<filename>
   Path-style + standard scheme so HLS playlists can reference sibling
   segments with plain relative URLs. */
const mediaUrl = (p) => {
  const dir = Buffer.from(path.dirname(p), 'utf8').toString('base64url');
  return `hikari-media://v/${dir}/${encodeURIComponent(path.basename(p))}`;
};

/* must run before app ready (registerSchemesAsPrivileged) — called from main.js top level.
   standard+secure: relative URL resolution works; supportFetchAPI: hls.js
   loads playlists/segments via fetch/XHR. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'hikari-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
  ]);
}

function registerProtocol() {
  protocol.registerFileProtocol('hikari-media', (req, cb) => {
    try {
      const u = new URL(req.url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (u.hostname !== 'v' || parts.length < 2) return cb({ error: -2 });
      const dir = Buffer.from(parts[0], 'base64url').toString('utf8');
      const name = decodeURIComponent(parts.slice(1).join('/'));
      const p = path.join(dir, name);
      if (pathAllowed(p) && fs.existsSync(p)) {
        fsp.utimes(p, new Date(), new Date()).catch(() => {}); // LRU touch
        cb({ path: norm(p) });
      } else {
        cb({ error: -6 }); // FILE_NOT_FOUND
      }
    } catch {
      cb({ error: -2 });
    }
  });
}

/* ——— folder scanning ——— */
const SEASON_DIR = [
  [/^season[ ._-]*(\d{1,2})$/i, (m) => ({ kind: +m[1] === 0 ? 'specials' : 'season', num: +m[1] })],
  [/^s(\d{1,2})$/i, (m) => ({ kind: +m[1] === 0 ? 'specials' : 'season', num: +m[1] })],
  [/^(\d{1,2})(?:st|nd|rd|th)[ ._-]*season$/i, (m) => ({ kind: 'season', num: +m[1] })],
  [/^(specials?|extras?|sp)$/i, () => ({ kind: 'specials', num: 0 })],
  [/^(ovas?|oads?|onas?)$/i, () => ({ kind: 'specials', num: 0 })],
  [/^(movies?|films?)$/i, () => ({ kind: 'movies', num: null })],
  /* messy real-world combos: "Movie + OVAs + Specials", "Extras & Bonus" … */
  [/special|ova|oad|extra|movie|film|bonus/i, () => ({ kind: 'mixed', num: null })]
];

function classifyDir(name) {
  for (const [re, make] of SEASON_DIR) {
    const m = re.exec(name.trim());
    if (m) return make(m);
  }
  return { kind: 'other', num: null };
}

async function listVideos(dir, cap = 2000) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= cap) break;
    if (!e.isFile()) continue;
    if (!VIDEO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let size = 0;
    try { size = (await fsp.stat(path.join(dir, e.name))).size; } catch {}
    if (size < MIN_BYTES) continue; // skip samples/extras
    out.push({ path: path.join(dir, e.name), name: e.name, size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/* one show folder → its season buckets */
async function scanShowDir(dir) {
  const buckets = [];
  const rootFiles = await listVideos(dir);
  if (rootFiles.length) buckets.push({ label: '', kind: 'root', num: null, files: rootFiles });
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cls = classifyDir(e.name);
    const files = await listVideos(path.join(dir, e.name));
    if (files.length) buckets.push({ label: e.name, kind: cls.kind, num: cls.num, files });
  }
  return buckets;
}

/* a library root: every child folder is a candidate show */
async function scanLibraryRoot(root) {
  const shows = [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    return { root, error: err.code === 'ENOENT' ? 'Folder not found (offline?)' : err.message, shows };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    /* a folder that IS a season dir means the root itself is a show folder */
    const buckets = await scanShowDir(dir);
    if (buckets.length) shows.push({ folder: dir, name: e.name, buckets });
  }
  /* loose show — videos or season dirs directly in the root */
  const selfBuckets = await scanShowDir(root);
  const seasonish = selfBuckets.filter((b) => b.kind !== 'other');
  if (!shows.length && seasonish.length) {
    shows.push({ folder: root, name: path.basename(root), buckets: selfBuckets });
  }
  return { root, shows };
}

/* ——— probing + playback preparation ——— */
function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return reject(new Error('Could not read this file (ffprobe failed)'));
        try {
          const j = JSON.parse(stdout);
          const streams = j.streams || [];
          let a = 0, s = 0;
          const audios = [], subs = [];
          let video = null;
          for (const st of streams) {
            if (st.codec_type === 'video' && !video && st.disposition?.attached_pic !== 1) {
              video = { codec: st.codec_name || '' };
            } else if (st.codec_type === 'audio') {
              audios.push({
                idx: a++, codec: st.codec_name || '',
                lang: (st.tags?.language || '').toLowerCase(),
                title: st.tags?.title || '', def: st.disposition?.default === 1,
                channels: st.channels || 2
              });
            } else if (st.codec_type === 'subtitle') {
              subs.push({
                idx: s++, codec: st.codec_name || '',
                lang: (st.tags?.language || '').toLowerCase(), title: st.tags?.title || ''
              });
            }
          }
          resolve({ video, audios, subs, duration: parseFloat(j.format?.duration) || 0, container: j.format?.format_name || '' });
        } catch { reject(new Error('Unreadable probe output')); }
      });
  });
}

const engish = (lang, title) => /^en/.test(lang) || /english/i.test(title || '');

function pickAudio(audios) {
  if (!audios.length) return null;
  return audios.find((x) => engish(x.lang, x.title))
    || audios.find((x) => x.def)
    || audios[0];
}
function pickSub(subs) {
  const usable = subs.filter((x) => !/pgs|dvd|hdmv/i.test(x.codec)); // bitmap subs can't become VTT
  return usable.find((x) => engish(x.lang, x.title) && !/sign|song/i.test(x.title || ''))
    || usable.find((x) => engish(x.lang, x.title))
    || usable[0] || null;
}

const DIRECT_V = new Set(['h264', 'vp8', 'vp9', 'av1']);
/* what MPEG-TS can carry as a straight copy — vp8/vp9/av1 cannot ride TS, so
   those still need the single-file mp4 remux */
const TS_COPY_V = new Set(['h264']);
const TS_COPY_A = new Set(['aac', 'mp3', 'ac3', 'eac3']);
const DIRECT_A = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const DIRECT_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov']);

/* what does this file need to play in-app? */
function decide(file, info, audio) {
  const ext = path.extname(file).toLowerCase();
  const audioIsPlayerDefault = !audio || audio.idx === 0 || info.audios.length === 1;
  if (DIRECT_EXT.has(ext) && DIRECT_V.has(info.video.codec) &&
      (!audio || DIRECT_A.has(audio.codec)) && audioIsPlayerDefault) return 'direct';
  return DIRECT_V.has(info.video.codec) ? 'remux' : 'transcode';
}

async function ensureCacheDir() {
  await fsp.mkdir(cacheDir(), { recursive: true }).catch(() => {});
}

async function dirSize(p) {
  let total = 0;
  try {
    for (const e of await fsp.readdir(p, { withFileTypes: true })) {
      const c = path.join(p, e.name);
      if (e.isFile()) total += (await fsp.stat(c)).size;
      else if (e.isDirectory()) total += await dirSize(c);
    }
  } catch {}
  return total;
}

const activeSessions = new Set(); // hls dirs currently being written

async function pruneCache() {
  try {
    const entries = await fsp.readdir(cacheDir(), { withFileTypes: true });
    const stats = [];
    let total = 0;
    for (const e of entries) {
      const p = path.join(cacheDir(), e.name);
      try {
        if (e.isFile()) {
          const st = await fsp.stat(p);
          stats.push({ p, size: st.size, at: st.atimeMs || st.mtimeMs, dir: false });
          total += st.size;
        } else if (e.isDirectory()) {
          const size = await dirSize(p);
          const st = await fsp.stat(p);
          stats.push({ p, size, at: st.atimeMs || st.mtimeMs, dir: true });
          total += size;
        }
      } catch {}
    }
    stats.sort((a, b) => a.at - b.at);
    for (const s of stats) {
      if (total <= CACHE_CAP) break;
      if (activeSessions.has(norm(s.p))) continue; // never evict a live session
      await fsp.rm(s.p, { force: true, recursive: true }).catch(() => {});
      total -= s.size;
    }
  } catch {}
}

function cacheKey(file, st, aIdx) {
  return crypto.createHash('sha1')
    .update(`${file}|${st.size}|${Math.floor(st.mtimeMs)}|a${aIdx}|v2`)
    .digest('hex');
}

function runFfmpeg(args, epKey, duration, kind) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-y', '-v', 'error', '-progress', 'pipe:1', ...args], { windowsHide: true });
    jobs.set(epKey, child);
    let err = '';
    child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
    child.stdout.on('data', (d) => {
      const m = /out_time_ms=(\d+)/.exec(String(d));
      if (m && duration > 0) {
        const pct = Math.min(99, Math.round((+m[1] / 1e6 / duration) * 100));
        getWin()?.webContents.send('media:progress', { epKey, pct, kind });
      }
    });
    child.on('close', (code, signal) => {
      jobs.delete(epKey);
      if (signal) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`));
    });
    child.on('error', (e) => { jobs.delete(epKey); reject(e); });
  });
}

async function analyse(file) {
  if (!pathAllowed(file)) throw new Error('That file is outside your linked folders');
  const st = await fsp.stat(file); // throws if missing/offline
  const info = await probe(file);
  if (!info.video) throw new Error('No video stream found');
  const audio = pickAudio(info.audios);
  return { st, info, audio, action: decide(file, info, audio) };
}

function hlsComplete(dir) {
  try { return fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').includes('#EXT-X-ENDLIST'); }
  catch { return false; }
}

/* live sessions become watchable once a couple of segments exist */
async function waitForPlaylist(dir, epKey) {
  for (let i = 0; i < 150; i++) {
    try {
      const pl = await fsp.readFile(path.join(dir, 'index.m3u8'), 'utf8');
      if ((pl.match(/\.ts/g) || []).length >= 2 || pl.includes('#EXT-X-ENDLIST')) return;
    } catch {}
    if (!jobs.has(epKey)) throw new Error('conversion stopped before playback could start');
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('conversion did not produce playable output in time');
}

async function extractSubs(file, info, vttOut, epKey) {
  const sub = pickSub(info.subs);
  if (!sub || fs.existsSync(vttOut)) return;
  await runFfmpeg(['-i', file, '-map', `0:s:${sub.idx}`, '-c:s', 'webvtt', vttOut], `${epKey}:sub`, 0, 'subs')
    .catch(() => fsp.rm(vttOut, { force: true }).catch(() => {}));
}

async function prepare(file, epKey, wait) {
  const { st, info, audio, action } = await analyse(file);

  if (action === 'direct') {
    return { mode: 'direct', url: mediaUrl(file), subs: [], duration: info.duration, audioLang: audio?.lang || '' };
  }

  await ensureCacheDir();
  const key = cacheKey(file, st, audio ? audio.idx : 0);
  const vttOut = path.join(cacheDir(), `${key}.vtt`);
  const aCopy = audio && ['aac', 'mp3'].includes(audio.codec);
  const mapArgs = ['-map', '0:v:0', ...(audio ? ['-map', `0:a:${audio.idx}`] : [])];
  const aArgs = audio ? ['-c:a', ...(aCopy ? ['copy'] : ['aac', '-b:a', '192k', '-ac', '2'])] : [];

  /* ——— remux ———
     A stream copy is the FAST operation, but writing it as a single mp4 made
     it the only one you had to sit and watch: `+faststart` rewrites the file
     to move the moov atom to the front, so nothing can be served until ffmpeg
     has finished the whole thing. The slow path (full re-encode) meanwhile
     played instantly because it writes HLS segments. That was backwards.

     So h264 — which is almost everything — now stream-copies into the SAME
     live HLS session below and starts playing off the first segment. Only the
     codecs MPEG-TS can't carry still take the blocking mp4 route. */
  if (action === 'remux' && !TS_COPY_V.has(info.video.codec)) {
    const out = path.join(cacheDir(), `${key}.mp4`);
    if (!fs.existsSync(out)) {
      try {
        await runFfmpeg(['-i', file, ...mapArgs, '-c:v', 'copy', ...aArgs, '-sn', '-dn', '-movflags', '+faststart', out],
          epKey, info.duration, 'remux');
      } catch (e) {
        await fsp.rm(out, { force: true }).catch(() => {});
        throw e;
      }
      await extractSubs(file, info, vttOut, epKey);
      pruneCache();
    }
    return {
      mode: 'remuxed', url: mediaUrl(out),
      subs: fs.existsSync(vttOut) ? [mediaUrl(vttOut)] : [],
      duration: info.duration, audioLang: audio?.lang || ''
    };
  }

  /* ——— live HLS session — playable while it runs, and the finished
         session IS the cache. Copies the video when the codec allows it
         (quality untouched, many times faster than real time) and only
         re-encodes when it has to. ——— */
  const copyVideo = action === 'remux';
  const dir = path.join(cacheDir(), `${key}.hls`);
  const playlist = path.join(dir, 'index.m3u8');
  const result = (mode) => ({
    mode, url: mediaUrl(playlist),
    subs: fs.existsSync(vttOut) ? [mediaUrl(vttOut)] : [],
    duration: info.duration, audioLang: audio?.lang || ''
  });

  if (hlsComplete(dir)) return result('hls-cached');
  if (fs.existsSync(dir) && !jobs.has(epKey)) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); // stale half-session
  }

  if (!jobs.has(epKey)) {
    await fsp.mkdir(dir, { recursive: true });
    activeSessions.add(norm(dir));
    /* a copy can't have keyframes forced into it — segments land on the
       encode's existing IDR frames, which is what -hls_time asks for anyway */
    const vArgs = copyVideo
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-force_key_frames', 'expr:gte(t,n_forced*4)']; // 4s segments = fast startup
    const aHls = audio
      ? ['-c:a', ...(copyVideo && TS_COPY_A.has(audio.codec)
        ? ['copy']
        : ['aac', '-b:a', '192k', '-ac', '2'])]
      : [];
    const done = runFfmpeg([
      '-i', file, ...mapArgs,
      ...vArgs, ...aHls,
      '-sn', '-dn',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event',
      '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
      playlist
    ], epKey, info.duration, copyVideo ? 'remux' : 'transcode')
      .then(() => {
        activeSessions.delete(norm(dir));
        getWin()?.webContents.send('media:progress', { epKey, pct: 100, kind: copyVideo ? 'remux' : 'transcode', done: true });
        pruneCache();
      })
      .catch(async (e) => {
        activeSessions.delete(norm(dir));
        if (!e.cancelled) {
          await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
          getWin()?.webContents.send('media:progress', { epKey, pct: -1, kind: copyVideo ? 'remux' : 'transcode', error: e.message });
        }
      });
    prepare._sessions = prepare._sessions || new Map();
    prepare._sessions.set(epKey, done);
    /* subtitles run off the source file in parallel — quick for text subs */
    extractSubs(file, info, vttOut, `${epKey}`);
  }

  if (wait) {
    await (prepare._sessions?.get(epKey) || Promise.resolve());
    if (!hlsComplete(dir)) {
      throw Object.assign(new Error('conversion was cancelled'), { cancelled: true });
    }
    return result('hls-cached');
  }
  await waitForPlaylist(dir, epKey);
  return result('hls-live');
}

/* ——— wiring ——— */
function init(opts) {
  getWin = opts.getWin;
  allowedRoots = opts.initialRoots || [];
  registerProtocol();

  ipcMain.handle('media:set-roots', (_e, roots) => {
    allowedRoots = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r);
    return true;
  });
  ipcMain.handle('media:pick-folder', async () => {
    const res = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('media:scan', async (_e, roots) => {
    const list = (Array.isArray(roots) ? roots : []).filter(Boolean);
    allowedRoots = [...new Set([...allowedRoots, ...list])];
    const out = [];
    for (const r of list) out.push(await scanLibraryRoot(r));
    return out;
  });
  ipcMain.handle('media:scan-show', async (_e, dir) => {
    if (typeof dir !== 'string' || !dir) return null;
    allowedRoots = [...new Set([...allowedRoots, dir])];
    return { folder: dir, name: path.basename(dir), buckets: await scanShowDir(dir) };
  });
  ipcMain.handle('media:prepare', async (_e, { file, epKey, wait }) => {
    try {
      return { ok: true, ...(await prepare(file, epKey, !!wait)) };
    } catch (err) {
      return { ok: false, cancelled: !!err.cancelled, error: err.message };
    }
  });
  ipcMain.handle('media:needs', async (_e, file) => {
    try {
      const { st, info, audio, action } = await analyse(file);
      if (action === 'direct') return { ok: true, action, cached: true };
      const key = cacheKey(file, st, audio ? audio.idx : 0);
      /* must agree with prepare(): only TS-hostile codecs land in an mp4 */
      const cached = (action === 'remux' && !TS_COPY_V.has(info.video.codec))
        ? fs.existsSync(path.join(cacheDir(), `${key}.mp4`))
        : hlsComplete(path.join(cacheDir(), `${key}.hls`));
      return { ok: true, action, cached };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('media:cancel', (_e, epKey) => {
    for (const k of [epKey, `${epKey}:sub`]) {
      const j = jobs.get(k);
      if (j) { try { j.kill('SIGKILL'); } catch {} jobs.delete(k); }
    }
    return true;
  });
  ipcMain.handle('media:exists', async (_e, file) => {
    try { await fsp.access(file); return pathAllowed(file); } catch { return false; }
  });
  ipcMain.handle('media:organize', async (_e, ops) => {
    const out = [];
    for (const op of Array.isArray(ops) ? ops : []) {
      try {
        if (typeof op.from !== 'string' || typeof op.to !== 'string' ||
            !pathAllowed(op.from) || !pathAllowed(op.to)) {
          out.push({ ...op, ok: false, error: 'outside linked folders' });
          continue;
        }
        if (norm(op.from) === norm(op.to)) { out.push({ ...op, ok: true, skipped: true }); continue; }
        if (fs.existsSync(op.to)) { out.push({ ...op, ok: false, error: 'a file with the target name already exists' }); continue; }
        await fsp.mkdir(path.dirname(op.to), { recursive: true });
        try {
          await fsp.rename(op.from, op.to);
        } catch (e) {
          if (e.code === 'EXDEV') { await fsp.copyFile(op.from, op.to); await fsp.rm(op.from); }
          else throw e;
        }
        out.push({ ...op, ok: true });
      } catch (err) {
        out.push({ ...op, ok: false, error: err.message });
      }
    }
    return out;
  });
  ipcMain.handle('media:open-external', (_e, file) => {
    if (typeof file === 'string' && pathAllowed(file) && fs.existsSync(file)) return shell.openPath(file);
    return 'blocked';
  });
}

/* invert mediaUrl — the remote server needs filesystem paths, not renderer URLs */
function urlToPath(u) {
  const url = new URL(u);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'v' || parts.length < 2) return null;
  const dir = Buffer.from(parts[0], 'base64url').toString('utf8');
  return path.join(dir, decodeURIComponent(parts.slice(1).join('/')));
}

module.exports = { registerScheme, init, prepare, pathAllowed, urlToPath, cacheDir };
