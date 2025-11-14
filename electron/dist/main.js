"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
let mainWindow = null;
let shouldAutoStart = false;
const moduleDir = __dirname;
const isDev = process.env.NODE_ENV !== "production" && !electron_1.app.isPackaged;
async function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1440,
        height: 900,
        webPreferences: {
            preload: path_1.default.join(moduleDir, "preload.js"),
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
        }
        else {
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
        : `file://${path_1.default.join(moduleDir, "../renderer/out/index.html")}`;
    await mainWindow.loadURL(startUrl);
    if (isDev) {
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
}
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.focus();
        }
    });
}
electron_1.app.on("ready", async () => {
    await createWindow();
    electron_1.globalShortcut.register("CommandOrControl+Shift+L", () => {
        shouldAutoStart = !shouldAutoStart;
        mainWindow?.webContents.send("assistant:toggle", shouldAutoStart);
    });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        electron_1.app.quit();
    }
});
electron_1.app.on("activate", () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
electron_1.ipcMain.on("assistant:transcript", (_event, transcript) => {
    if (isDev) {
        console.log("[Assistant] transcript:", transcript);
    }
});
electron_1.ipcMain.on("assistant:request-start", () => {
    shouldAutoStart = true;
});
electron_1.ipcMain.on("assistant:request-stop", () => {
    shouldAutoStart = false;
});
