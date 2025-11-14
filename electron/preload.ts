import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("assistantBridge", {
  submitTranscript: (text: string) => ipcRenderer.send("assistant:transcript", text),
  onToggle: (callback: (shouldStart: boolean) => void) => {
    ipcRenderer.removeAllListeners("assistant:toggle");
    ipcRenderer.on("assistant:toggle", (_event, shouldStart: boolean) => {
      callback(shouldStart);
    });
  },
  requestStart: () => ipcRenderer.send("assistant:request-start"),
  requestStop: () => ipcRenderer.send("assistant:request-stop"),
});

