"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld("assistantBridge", {
    submitTranscript: (text) => electron_1.ipcRenderer.send("assistant:transcript", text),
    onToggle: (callback) => {
        electron_1.ipcRenderer.removeAllListeners("assistant:toggle");
        electron_1.ipcRenderer.on("assistant:toggle", (_event, shouldStart) => {
            callback(shouldStart);
        });
    },
    requestStart: () => electron_1.ipcRenderer.send("assistant:request-start"),
    requestStop: () => electron_1.ipcRenderer.send("assistant:request-stop"),
});
