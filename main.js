const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const media = require('./media');

media.registerScheme(); // must happen before app ready

/* test harnesses point this at a throwaway dir to keep the real library safe —
   MUST run before the single-instance lock so tests lock their own dir */
if (process.env.HIKARI_DATA_DIR) app.setPath('userData', process.env.HIKARI_DATA_DIR);

/* ONE instance per data dir. A second launch (dev + installed, or a forgotten
   orphan) would share library.json and eventually clobber it with stale
   memory — exactly how a 182-show library got overwritten by a day-one state. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const isMac = process.platform === 'darwin';
let win;

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/* stable identity so Windows toasts attribute to Hikari (matches build.appId) */
app.setAppUserModelId('dev.lewis.hikari');

const dataPath = () => path.join(app.getPath('userData'), 'library.json');
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}
async function saveSettings(obj) {
  if (typeof obj !== 'object' || obj === null) return false;
  await fs.writeFile(settingsPath(), JSON.stringify(obj, null, 2), 'utf8');
  return true;
}

async function loadLibrary() {
  try {
    const raw = await fs.readFile(dataPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveLibrary(items) {
  if (!Array.isArray(items)) return false;
  /* shrink guard: a save that wipes most of the library is far more likely a
     stale writer than intent — keep a pre-shrink snapshot before honouring it */
  try {
    const existing = JSON.parse(await fs.readFile(dataPath(), 'utf8'));
    if (Array.isArray(existing) && existing.length > 20 && items.length < existing.length / 2) {
      await fs.writeFile(
        dataPath().replace(/\.json$/, `.pre-shrink-${Date.now()}.json`),
        JSON.stringify(existing), 'utf8');
    }
  } catch { /* nothing readable to protect */ }
  await fs.writeFile(dataPath(), JSON.stringify(items, null, 2), 'utf8');
  return true;
}

/* three-generation rolling backup, rotated once per launch */
async function rotateLibraryBackups() {
  try {
    const src = dataPath();
    await fs.access(src);
    for (let i = 2; i >= 1; i--) {
      const from = src.replace(/\.json$/, `.backup${i}.json`);
      const to = src.replace(/\.json$/, `.backup${i + 1}.json`);
      try { await fs.copyFile(from, to); } catch {}
    }
    await fs.copyFile(src, src.replace(/\.json$/, '.backup1.json'));
  } catch { /* first run — nothing to back up */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    autoHideMenuBar: true,
    backgroundColor: '#F3EFE7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
}

app.whenReady().then(async () => {
  await rotateLibraryBackups();
  media.init({
    getWin: () => win,
    initialRoots: (await loadSettings()).mediaRoots || []
  });

  /* remote play: LAN server so the mobile app can stream this machine's
     files through the same prepare() pipeline the desktop player uses.
     The address+token reach the phone via the synced settings row. */
  const remote = require('./remote.js');
  {
    const s = await loadSettings();
    if (!s.remoteToken) {
      s.remoteToken = require('crypto').randomBytes(12).toString('base64url');
      await saveSettings(s);
    }
    await remote.init({
      token: s.remoteToken,
      enabled: s.remoteEnabled !== false,        // opt-out, so existing installs are unchanged
      getVersion: () => app.getVersion(),
      readLibrary: () => {
        try {
          const j = JSON.parse(require('fs').readFileSync(dataPath(), 'utf8'));
          return Array.isArray(j) ? j : [];
        } catch { return []; }
      }
    });
  }
  ipcMain.handle('remote:info', () => remote.info());
  /* let the renderer turn the LAN server off, or rotate its token */
  ipcMain.handle('remote:set-enabled', async (_e, on) => {
    const s = await loadSettings();
    s.remoteEnabled = !!on;
    await saveSettings(s);
    return on ? remote.start() : remote.stop();
  });
  ipcMain.handle('remote:rotate-token', async () => {
    const s = await loadSettings();
    s.remoteToken = require('crypto').randomBytes(12).toString('base64url');
    await saveSettings(s);
    return remote.setToken(s.remoteToken);
  });
  ipcMain.handle('library:get', () => loadLibrary());
  ipcMain.handle('library:set', (_e, items) => saveLibrary(items));
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, obj) => saveSettings(obj));

  /* backup: export/import the whole library as JSON
     (HIKARI_EXPORT_PATH / HIKARI_IMPORT_PATH bypass dialogs for test harnesses) */
  ipcMain.handle('data:export', async (_e, payload) => {
    try {
      let file = process.env.HIKARI_EXPORT_PATH;
      if (!file) {
        const stamp = new Date().toISOString().slice(0, 10);
        const res = await dialog.showSaveDialog(win, {
          title: 'Export Hikari library',
          defaultPath: `hikari-backup-${stamp}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (res.canceled || !res.filePath) return { ok: false, canceled: true };
        file = res.filePath;
      }
      await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('data:import', async () => {
    try {
      let file = process.env.HIKARI_IMPORT_PATH;
      if (!file) {
        const res = await dialog.showOpenDialog(win, {
          title: 'Import Hikari library',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile']
        });
        if (res.canceled || !res.filePaths?.[0]) return { ok: false, canceled: true };
        file = res.filePaths[0];
      }
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
  });

  /* About panel: version + runtime + where the data lives */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir: app.getPath('userData')
  }));
  ipcMain.handle('app:open-data', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('media:reveal', (_e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(path.normalize(p));
  });

  /* CORS-free JSON fetches for metadata hosts that lack CORS headers */
  const NET_ALLOW = new Set(['arm.haglund.dev', 'skyhook.sonarr.tv', 'webservice.fanart.tv', 'animeschedule.net']);
  ipcMain.handle('net:json', async (_e, url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !NET_ALLOW.has(u.hostname)) return null;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  });

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:maximize', () => {
    if (!win) return;
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on('win:close', () => win && win.close());
  ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
