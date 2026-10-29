const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame)
  contextBridge.exposeInMainWorld("vizorDesktop", {
    terminals: {
      tools: () => ipcRenderer.invoke("vizor:terminal", "tools"),
      install: (engine) =>
        ipcRenderer.invoke("vizor:terminal", "install", { engine }),
      setup: (engine) =>
        ipcRenderer.invoke("vizor:terminal", "setup", { engine }),
      chooseFolder: () => ipcRenderer.invoke("vizor:terminal-folder"),
      start: (agentId, confirmShared = false) =>
        ipcRenderer.invoke("vizor:terminal", "start", {
          agentId,
          confirmShared,
        }),
      snapshot: (agentId) =>
        ipcRenderer.invoke("vizor:terminal", "snapshot", { agentId }),
      input: (agentId, token, data) =>
        ipcRenderer.invoke("vizor:terminal", "input", { agentId, token, data }),
      resize: (agentId, token, cols, rows) =>
        ipcRenderer.invoke("vizor:terminal", "resize", {
          agentId,
          token,
          cols,
          rows,
        }),
      interrupt: (agentId, token) =>
        ipcRenderer.invoke("vizor:terminal", "interrupt", { agentId, token }),
      stop: (agentId, token) =>
        ipcRenderer.invoke("vizor:terminal", "stop", { agentId, token }),
      onEvent: (callback) => {
        const listener = (_event, value) => callback(value);
        ipcRenderer.on("vizor:terminal-event", listener);
        return () =>
          ipcRenderer.removeListener("vizor:terminal-event", listener);
      },
    },
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
