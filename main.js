const { app, BrowserWindow, screen, ipcMain } = require('electron');
const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');

let win;
let daemon;
let followTimer;
let lastHostKey = '';

// Apps to anchor the pill to (in priority order). Claude desktop app first.
const FOLLOW_APPS = ['Claude', 'Conductor', 'iTerm2', 'Terminal', 'Code'];

function queryAppWindow(appName) {
  return new Promise((resolve) => {
    const script =
      `tell application "System Events"\n` +
      `  if not (exists (process "${appName}")) then return ""\n` +
      `  tell process "${appName}"\n` +
      `    if (count of windows) = 0 then return ""\n` +
      `    set p to position of front window\n` +
      `    set s to size of front window\n` +
      `    return (item 1 of p as integer) & "," & (item 2 of p as integer) & "," & (item 1 of s as integer) & "," & (item 2 of s as integer)\n` +
      `  end tell\n` +
      `end tell`;
    exec(`osascript -e ${JSON.stringify(script)}`, { timeout: 800 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = (stdout || '').toString().trim();
      if (!out) return resolve(null);
      const parts = out.split(',').map(s => parseInt(s.trim(), 10));
      if (parts.some(isNaN)) return resolve(null);
      const [x, y, w, h] = parts;
      resolve({ x, y, width: w, height: h });
    });
  });
}

async function findHostWindow() {
  for (const appName of FOLLOW_APPS) {
    const bounds = await queryAppWindow(appName);
    if (bounds && bounds.width > 200 && bounds.height > 200) return bounds;
  }
  return null;
}

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
const HOST_ANCHOR_OFFSET = { right: 18, top: 86 };

let cachedHost = null;

async function refreshHost() {
  cachedHost = await findHostWindow();
  return cachedHost;
}

function anchorBoundsFor(size) {
  // If we have a host window, anchor top-right inside it; else fall back to screen.
  if (cachedHost) {
    const x = cachedHost.x + cachedHost.width - size.w - HOST_ANCHOR_OFFSET.right;
    const y = cachedHost.y + HOST_ANCHOR_OFFSET.top;
    return { x, y, width: size.w, height: size.h };
  }
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
  return {
    x: sw - size.w - MARGIN_RIGHT,
    y: MARGIN_TOP,
    width: size.w,
    height: size.h,
  };
}

function fullBounds() { return anchorBoundsFor(SIZE_FULL); }
function pillBounds() { return anchorBoundsFor(SIZE_PILL); }

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

// Trigger macOS Accessibility prompt for Electron if not already granted.
// First osascript call against System Events will pop the dialog.
function triggerAccessibilityPrompt() {
  exec(`osascript -e 'tell application "System Events" to return name of first process'`, { timeout: 800 }, (err) => {
    if (err) console.log('[toot] Accessibility permission needed for host-window tracking. System Settings → Privacy & Security → Accessibility → add Electron.');
  });
}

app.whenReady().then(async () => {
  triggerAccessibilityPrompt();
  await startDaemon();
  await refreshHost();
  createWindow();
  startFollowingHost();
});

// Poll the host (Claude / Conductor / Terminal) window position and reposition the pill to track it.
function startFollowingHost() {
  if (followTimer) clearInterval(followTimer);
  followTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    const host = await findHostWindow();
    if (!host) return;
    const key = `${host.x},${host.y},${host.width},${host.height}`;
    if (key === lastHostKey) return;
    lastHostKey = key;
    cachedHost = host;
    // Reposition based on current view (pill vs full). Use width as the discriminator.
    const cur = win.getBounds();
    const isMin = Math.abs(cur.width - SIZE_PILL.w) < 30;
    const target = isMin ? pillBounds() : fullBounds();
    // Smooth-tween into the new position
    smoothResize(target, 300);
  }, 1000);
}

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
