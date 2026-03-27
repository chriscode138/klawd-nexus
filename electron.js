const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('path');
const { spawn, execSync } = require('child_process');

// Force the app name BEFORE anything else
app.setName('Klawd Nexus');

// Patch the Electron binary's Info.plist so macOS shows "Klawd Nexus" in the menu bar
if (process.platform === 'darwin') {
  try {
    const electronPath = path.dirname(process.execPath);
    const plistPath = path.join(electronPath, '..', 'Info.plist');
    const fs = require('fs');
    if (fs.existsSync(plistPath)) {
      let plist = fs.readFileSync(plistPath, 'utf-8');
      if (!plist.includes('Klawd Nexus')) {
        plist = plist.replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
          '<key>CFBundleName</key>\n\t<string>Klawd Nexus</string>');
        plist = plist.replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
          '<key>CFBundleDisplayName</key>\n\t<string>Klawd Nexus</string>');
        fs.writeFileSync(plistPath, plist, 'utf-8');
      }
    }
  } catch {}
}

let mainWindow = null;
let tray = null;
const PORT = 4000;

// ─── Start the Express server in-process (no child spawn = no second dock icon) ───
function startServer() {
  return new Promise((resolve) => {
    process.env.PORT = String(PORT);
    require('./server.js');
    // Give the server a moment to bind
    setTimeout(resolve, 1500);
  });
}

// ─── Create the main window ───
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Klawd Nexus',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 16 },
    } : {}),
    backgroundColor: '#06060c',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);

  // Show window when ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App menu ───
function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── App lifecycle ───
app.whenReady().then(async () => {
  // Build first if needed
  try {
    const { execSync } = require('child_process');
    execSync('npm run build', { cwd: __dirname, stdio: 'pipe' });
  } catch {}

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    try {
      const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
      app.dock.setIcon(icon);
    } catch {}
  }

  await startServer();
  createMenu();
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

app.on('before-quit', () => {
  // Server runs in-process, exits automatically with the app
});

// Set the app name
app.setName('Klawd Nexus');
