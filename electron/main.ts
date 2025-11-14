import { app, BrowserWindow, ipcMain, globalShortcut } from "electron";
import path from "path";

type MaybeWindow = BrowserWindow | null;

let mainWindow: MaybeWindow = null;
let shouldAutoStart = false;

const moduleDir = __dirname;
const isDev = process.env.NODE_ENV !== "production" && !app.isPackaged;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(moduleDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow Web Speech API to work in Electron
      webSecurity: true, // Keep security enabled but allow speech API
      allowRunningInsecureContent: false,
      // Enable experimental features that might help with Web Speech API
      experimentalFeatures: true,
    },
  });
  
  // Set user agent to help with Web Speech API compatibility
  const chromeUserAgent = mainWindow.webContents.getUserAgent().replace(/Electron\/[\d.]+/, "Chrome/120.0.0.0");
  mainWindow.webContents.setUserAgent(chromeUserAgent);
  
  // Grant permissions for media (includes microphone access)
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    // "media" permission covers microphone access for Web Speech API
    if (permission === "media") {
      callback(true); // Grant permission
    } else {
      callback(false);
    }
  });
  
  // Log when permissions are requested (for debugging)
  if (isDev) {
    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
      if (permission === "media") {
        console.log("[Electron] Permission check for:", permission);
        return true;
      }
      return false;
    });
  }

  const startUrl = isDev
    ? "http://localhost:3000"
    : `file://${path.join(moduleDir, "../renderer/out/index.html")}`;

  await mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on("ready", async () => {
  await createWindow();

  globalShortcut.register("CommandOrControl+Shift+L", () => {
    shouldAutoStart = !shouldAutoStart;
    mainWindow?.webContents.send("assistant:toggle", shouldAutoStart);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on("assistant:transcript", (_event, transcript: string) => {
  if (isDev) {
    console.log("[Assistant] transcript:", transcript);
  }
});

ipcMain.on("assistant:request-start", () => {
  shouldAutoStart = true;
});

ipcMain.on("assistant:request-stop", () => {
  shouldAutoStart = false;
});
