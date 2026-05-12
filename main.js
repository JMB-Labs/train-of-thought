const { app, BrowserWindow, screen, ipcMain, systemPreferences, dialog, shell } = require('electron');
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
    // Return a list so osascript prints "x, y, w, h" cleanly
    const script =
      `tell application "System Events"\n` +
      `  if not (exists (process "${appName}")) then return ""\n` +
      `  tell process "${appName}"\n` +
      `    if (count of windows) = 0 then return ""\n` +
      `    set p to position of front window\n` +
      `    set s to size of front window\n` +
      `    return {item 1 of p, item 2 of p, item 1 of s, item 2 of s}\n` +
      `  end tell\n` +
      `end tell`;
    // Use spawn with absolute osascript path (Electron's restricted PATH can miss it)
    const ps = spawn('/usr/bin/osascript', ['-e', script]);
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => { try { ps.kill(); } catch {} resolve(null); }, 25000);
    ps.stdout.on('data', d => stdout += d);
    ps.stderr.on('data', d => stderr += d);
    ps.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) {
        console.log(`[toot] ${appName} osascript exit=${code} stderr="${stderr.trim()}" stdout="${stdout.trim()}"`);
        return resolve(null);
      }
      if (!stdout.trim()) return resolve(null);
      const parts = stdout.trim().split(',').map(s => parseInt(s.trim(), 10));
      if (parts.some(isNaN)) {
        console.log(`[toot] ${appName} unparseable stdout="${stdout.trim()}"`);
        return resolve(null);
      }
      const [x, y, w, h] = parts;
      resolve({ x, y, width: w, height: h });
    });
    ps.on('error', (e) => { clearTimeout(t); console.log(`[toot] ${appName} spawn error: ${e.message}`); resolve(null); });
  });
}

async function findHostWindow() {
  console.log('[toot] findHostWindow polling...');
  for (const appName of FOLLOW_APPS) {
    const bounds = await queryAppWindow(appName);
    if (bounds) {
      console.log(`[toot]   ${appName}: ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
      if (bounds.width > 200 && bounds.height > 200) return bounds;
    } else {
      console.log(`[toot]   ${appName}: not found / no bounds`);
    }
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

// Min view is a proper compact pill; max view is a tall narrow column.
// Anchored top-right of the screen, always.
const SIZE_FULL = { w: 360, h: 680 };  // tall narrow column, grows downward
const SIZE_PILL = { w: 240, h: 72 };   // proper small pill
const MARGIN_RIGHT = 18;
const MARGIN_TOP = 12;

function anchorBoundsFor(size) {
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

// Track whether the user has manually moved the window.
// If yes, min↔max preserves the user's position instead of snapping back to top-right.
let userMoved = false;
let userPos = null;
let lastProgrammaticBounds = null;

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

  // Detect user drag (vs. our own programmatic resizes via smoothResize)
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const cur = win.getBounds();
    const tracked = lastProgrammaticBounds;
    if (!tracked) return;
    if (Math.abs(cur.x - tracked.x) > 3 || Math.abs(cur.y - tracked.y) > 3) {
      userMoved = true;
      userPos = { x: cur.x, y: cur.y };
    }
  });
}

// macOS Accessibility — call with `true` to trigger the system permission prompt if not granted.
function ensureAccessibility() {
  if (process.platform !== 'darwin') return true;
  const trusted = systemPreferences.isTrustedAccessibilityClient(true); // true = prompt if missing
  console.log('[toot] Accessibility trusted:', trusted);
  if (!trusted) {
    // Show a friendly dialog with the deeplink so Sir can find the settings
    setTimeout(() => {
      const r = dialog.showMessageBoxSync({
        type: 'info',
        title: 'Accessibility permission',
        message: 'Train of Thought needs Accessibility permission to anchor the pill to your Claude window.',
        detail: 'Open System Settings → Privacy & Security → Accessibility, then enable Electron. After enabling, restart the app.',
        buttons: ['Open Accessibility Settings', 'Later'],
        defaultId: 0,
      });
      if (r === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
    }, 600);
  }
  return trusted;
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
    const intermediate = {
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    };
    win.setBounds(intermediate);
    lastProgrammaticBounds = intermediate;  // so 'moved' can tell user drag from this
    if (t < 1) setTimeout(tick, 16);
  }
  tick();
}

ipcMain.on('set-view', (_, view) => {
  if (!win) return;
  const size = view === 'minimized' ? SIZE_PILL : SIZE_FULL;
  // If the user has dragged the window, preserve their position and only change the size.
  // Otherwise snap to the default top-right anchor.
  let target;
  if (userMoved && userPos) {
    target = { x: userPos.x, y: userPos.y, width: size.w, height: size.h };
  } else {
    target = view === 'minimized' ? pillBounds() : fullBounds();
  }
  smoothResize(target, 550);
});

ipcMain.on('quit', () => app.quit());
ipcMain.on('hide', () => win?.hide());
