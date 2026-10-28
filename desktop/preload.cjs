const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame)
  contextBridge.exposeInMainWorld("vizorDesktop", {
    getUpdateState: () => ipcRenderer.invoke("vizor:update-state"),
    checkForUpdates: () => ipcRenderer.invoke("vizor:update-check"),
    setAutomaticUpdates: (enabled) =>
      ipcRenderer.invoke("vizor:update-automatic", enabled),
    restartToUpdate: () => ipcRenderer.invoke("vizor:update-restart"),
    onUpdateState: (callback) => {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("vizor:update-state", handler);
      return () => ipcRenderer.removeListener("vizor:update-state", handler);
    },
  });
