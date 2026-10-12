const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Google sign-in only accepts web addresses it has been told about, not file:// pages. So the packaged app serves
// its own files on this address, which is already registered as an allowed origin for ShapeForge.
const APP_PORT = 5173;
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

// Sign-in runs in the person's own browser (Google refuses app windows). It comes back here, and the page collects
// the result by asking this same server for it.
const authResults = new Map();
const DONE_PAGE = (text) => `<!doctype html><meta charset="utf-8"><title>ShapeForge</title><body style="font:18px system-ui;margin:3em auto;max-width:28em"><h2>ShapeForge</h2><p>${text}</p>`;

function handleAuth(req, res) {
  const url = new URL(req.url || '/', APP_ORIGIN);
  if (url.pathname === '/__auth/available') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('shapeforge-desktop');
    return true;
  }
  if (url.pathname === '/oauth-callback') {
    const state = url.searchParams.get('state') || '';
    if (state) authResults.set(state, { code: url.searchParams.get('code') || '', error: url.searchParams.get('error') || '' });
    const ok = !!url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DONE_PAGE(ok ? 'Signed in. You can close this tab and go back to the ShapeForge app.' : 'Sign-in was not completed. Go back to ShapeForge and try again.'));
    return true;
  }
  if (url.pathname === '/__auth/poll') {
    const state = url.searchParams.get('state') || '';
    const found = authResults.get(state);
    if (!found) { res.writeHead(204); res.end(); return true; }
    authResults.delete(state);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(found));
    return true;
  }
  return false;
}

function startLocalServer() {
  const root = path.join(__dirname, '../dist');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (handleAuth(req, res)) return;
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.once('error', reject);
    server.listen(APP_PORT, '127.0.0.1', () => resolve());
  });
}

// High-performance graphics configuration
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('high-dpi-support', '1');

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'ShapeForge 3D',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  });

  // Open external links (including Google's sign-in page) in the default OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadURL(APP_ORIGIN + '/index.html');
  }

  // Keyboard shortcut for DevTools (F12 or Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// A second copy could not use the page address the first one holds, and would open blank: bring the first forward.
const hasLock = isDev || app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (!hasLock) return;
  // Google refuses sign-in from browsers that call themselves Electron.
  const cleanAgent = (agent) => agent.replace(/\s*Electron\/\S+/, '').replace(/\s*shapeforge\/\S+/i, '');
  app.userAgentFallback = cleanAgent(app.userAgentFallback);
  if (!isDev) {
    try { await startLocalServer(); } catch (error) { console.error('Could not start the local page server', error); }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
