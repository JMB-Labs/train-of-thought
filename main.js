const { app, BrowserWindow, screen, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

let win;
let daemon;

function pingDaemon() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 3801, path: '/health', timeout: 500 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startDaemon() {
  if (await pingDaemon()) {
    console.log('[toot] daemon already running, attaching');
    return;
  }
  daemon = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: false,
  });
  daemon.on('exit', (code) => console.log('[toot] daemon exited:', code));
}

const SIZE_FULL = { w: 800, h: 560 };
const SIZE_PILL = { w: 240, h: 80 };
const MARGIN_RIGHT = 24;
const MARGIN_TOP = 70;

function fullBounds() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: sw - SIZE_FULL.w - MARGIN_RIGHT,
    y: MARGIN_TOP,
    width: SIZE_FULL.w,
    height: SIZE_FULL.h,
  };
}

function pillBounds() {
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: sw - SIZE_PILL.w - MARGIN_RIGHT,
    y: MARGIN_TOP,
    width: SIZE_PILL.w,
    height: SIZE_PILL.h,
  };
}

function createWindow() {
  const b = fullBounds();

  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    backgroundColor: '#00000000',
    title: 'Train of Thought',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.setWindowButtonVisibility?.(false);
  win.loadFile('renderer/index.html');
  win.setAlwaysOnTop(true, 'floating');
}

app.whenReady().then(async () => {
  await startDaemon();
  createWindow();
});

app.on('before-quit', () => {
  if (daemon && !daemon.killed) daemon.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function smoothResize(target, duration = 500) {
  if (!win) return;
  const start = win.getBounds();
  const startTime = Date.now();
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  function tick() {
    if (!win || win.isDestroyed()) return;
    const elapsed = Date.now() - startTime;
    const t = Math.min(elapsed / duration, 1);
    const e = easeOutCubic(t);
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    });
    if (t < 1) setTimeout(tick, 16);
  }
  tick();
}

ipcMain.on('set-view', (_, view) => {
  if (!win) return;
  const target = view === 'minimized' ? pillBounds() : fullBounds();
  smoothResize(target, 350);
});

ipcMain.on('quit', () => app.quit());
ipcMain.on('hide', () => win?.hide());
