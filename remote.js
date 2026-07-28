/* Hikari — remote play server (main process).
   A small LAN HTTP server that lets the mobile app stream the desktop's
   local files through the SAME media pipeline the desktop player uses:
   direct mp4s range-stream as-is, remuxes serve the cached mp4, everything
   else rides the live-HLS transcode session.

   Auth: a per-install token that travels INSIDE the path
   (/hikari/<token>/…) — HLS playlists reference segments relatively, so
   query-string tokens would fall off the segment requests.
   The address+token reach the phone through the synced settings row. */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const media = require('./media.js');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
  '.vtt': 'text/vtt', '.json': 'application/json'
};

let server = null;
let boundPort = 0;
let TOKEN = '';
let readLibrary = () => [];
let getVersion = () => '0';

/* resolved play sessions: "mid:n" -> {file, sub} (fs paths) */
const sessions = new Map();

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const norm = (p) => path.normalize(p);

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  /* home-router ranges first; 10.x last among private — VPNs love it */
  const score = (ip) =>
    /^192\.168\./.test(ip) ? 3 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : /^10\./.test(ip) ? 1 : 0;
  return out.sort((a, b) => score(b) - score(a));
}

function tokenOk(t) {
  if (typeof t !== 'string' || t.length !== TOKEN.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); } catch { return false; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* find an on-disk file for a season media id + episode number */
function resolveEpisode(mid, n) {
  for (const rec of readLibrary()) {
    const paths = rec.local?.map?.[mid]?.[n];
    if (!Array.isArray(paths)) continue;
    for (const p of paths) if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureSession(mid, n) {
  const key = `${mid}:${n}`;
  const file = resolveEpisode(mid, n);
  if (!file) throw new Error('file not on disk');
  const res = await media.prepare(file, `remote:${key}`, false);
  const out = {
    mode: res.mode,
    duration: res.duration || null,
    file: res.mode === 'direct' ? file : media.urlToPath(res.url),
    sub: res.subs?.[0] ? media.urlToPath(res.subs[0]) : null
  };
  sessions.set(key, out);
  return out;
}

/* Range-aware file streaming (mp4 seeks need 206s) */
function streamFile(req, res, file, type) {
  let st;
  try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'gone' }); }
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10));
    const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': end - start + 1
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  }
  fsp.utimes(file, new Date(), new Date()).catch(() => {}); // cache LRU touch
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'hikari') return json(res, 404, { error: 'not found' });

  if (parts[1] === 'ping') return json(res, 200, { app: 'hikari', version: getVersion() });

  if (!tokenOk(parts[1])) return json(res, 401, { error: 'bad token' });
  const [, , route, a, b] = parts;

  try {
    if (route === 'manifest') {
      const shows = {};
      for (const rec of readLibrary()) {
        for (const [mid, em] of Object.entries(rec.local?.map || {})) {
          const eps = Object.keys(em).map(Number)
            .filter((n) => Array.isArray(em[n]) && em[n].length);
          if (!eps.length) continue;
          shows[mid] = [...new Set([...(shows[mid] || []), ...eps])].sort((x, y) => x - y);
        }
      }
      return json(res, 200, { shows });
    }

    if (route === 'play') {
      const mid = String(parseInt(a, 10));
      const n = String(parseInt(b, 10));
      const s = await ensureSession(mid, n);
      const base = `/hikari/${TOKEN}`;
      if (s.mode === 'hls-live' || s.mode === 'hls-cached') {
        return json(res, 200, {
          type: 'hls',
          live: s.mode === 'hls-live',
          url: `${base}/hls/${b64(path.dirname(s.file))}/${encodeURIComponent(path.basename(s.file))}`,
          sub: s.sub ? `${base}/sub/${mid}/${n}` : null,
          duration: s.duration
        });
      }
      return json(res, 200, {
        type: 'file',
        url: `${base}/file/${mid}/${n}`,
        sub: s.sub ? `${base}/sub/${mid}/${n}` : null,
        duration: s.duration
      });
    }

    if (route === 'file') {
      const key = `${parseInt(a, 10)}:${parseInt(b, 10)}`;
      const s = sessions.get(key) || await ensureSession(parseInt(a, 10), parseInt(b, 10));
      const type = MIME[path.extname(s.file).toLowerCase()] || 'application/octet-stream';
      return streamFile(req, res, s.file, type);
    }

    if (route === 'sub') {
      const key = `${parseInt(a, 10)}:${parseInt(b, 10)}`;
      const s = sessions.get(key);
      if (!s?.sub || !fs.existsSync(s.sub)) return json(res, 404, { error: 'no subs' });
      return streamFile(req, res, s.sub, 'text/vtt');
    }

    if (route === 'hls') {
      const dir = unb64(a);
      const name = decodeURIComponent(b || '');
      const p = path.join(dir, name);
      /* only ever serve out of the media cache, and never traverse */
      if (!norm(p).toLowerCase().startsWith(norm(media.cacheDir()).toLowerCase() + path.sep)
        || name.includes('..') || name.includes('/') || name.includes('\\')) {
        return json(res, 403, { error: 'outside cache' });
      }
      if (!fs.existsSync(p)) return json(res, 404, { error: 'gone' });
      const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
      if (p.endsWith('.m3u8')) {
        /* live playlists grow — the player must always refetch */
        res.writeHead(200, {
          'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'
        });
        return res.end(fs.readFileSync(p));
      }
      return streamFile(req, res, p, type);
    }

    return json(res, 404, { error: 'unknown route' });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e).slice(0, 200) });
  }
}

function listen(ports) {
  return new Promise((resolve) => {
    const tryPort = (i) => {
      if (i >= ports.length) return resolve(0);
      const s = http.createServer(handle);
      s.on('error', () => tryPort(i + 1));
      s.listen(ports[i], '0.0.0.0', () => { server = s; resolve(ports[i]); });
    };
    tryPort(0);
  });
}

async function init(opts) {
  readLibrary = opts.readLibrary;
  getVersion = opts.getVersion || getVersion;
  TOKEN = opts.token;
  if (opts.enabled === false) { boundPort = 0; return info(); }
  return start();
}

/* This binds 0.0.0.0 and serves your media library to anything on the LAN
   that holds the token, so it has to be stoppable — and the token has to be
   rotatable if it ever leaks (the phone picks the new one up on its next
   sync, since the address+token ride the synced settings row). */
async function start() {
  if (server) return info();
  boundPort = await listen([8971, 8972, 8973, 8974, 8975]);
  return info();
}

function stop() {
  if (!server) return info();
  try { server.close(); } catch { /* already down */ }
  server = null;
  boundPort = 0;
  return info();
}

function setToken(t) {
  TOKEN = t;
  return info();
}

function info() {
  return { running: !!server, port: boundPort, token: TOKEN, ips: lanIPs() };
}

module.exports = { init, start, stop, setToken, info };
