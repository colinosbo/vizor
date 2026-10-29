const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
  nativeTheme,
  ipcMain,
} = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createServer } = require("node:net");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const {
  workspacePaths,
  localNavigation,
  externalLink,
} = require("./policy.cjs");
app.setName("Vizor");
nativeTheme.themeSource = "dark";
app.setAppUserModelId("com.colinosbo.vizor");
const paths = workspacePaths(
  process.env.LOCALAPPDATA,
  process.env.VIZOR_DESKTOP_DATA_DIR,
);
mkdirSync(paths.shell, { recursive: true });
mkdirSync(paths.workspace, { recursive: true, mode: 0o700 });
app.setPath("userData", paths.shell);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-sync");
let window;
let launcher;
let origin;
let quitting = false;
let stopped = false;
let failed = false;
let updates;
let terminals;
let stoppingBackend;
let startup;
const activityRequests = new Map();
function stopBackend() {
  if (stoppingBackend) return stoppingBackend;
  if (!launcher || launcher.exitCode !== null) {
    stopped = true;
    return Promise.resolve();
  }
  stoppingBackend = new Promise((resolve) => {
    const timer = setTimeout(() => {
      spawnSync(
        join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"),
        ["/pid", String(launcher.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
    }, 12000);
    timer.unref();
    launcher.once("exit", () => {
      clearTimeout(timer);
      stopped = true;
      resolve();
    });
    void (terminals?.close() ?? Promise.resolve()).finally(() => {
      if (launcher.connected) launcher.send({ type: "stop" });
      else launcher.kill();
    });
  });
  return stoppingBackend;
}
function activity() {
  if (terminals?.count()) return Promise.resolve(terminals.count());
  if (!launcher?.connected || stopped || quitting) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      activityRequests.delete(id);
      resolve(null);
    }, 2500);
    timer.unref();
    activityRequests.set(id, (active) => {
      clearTimeout(timer);
      resolve(active);
    });
    launcher.send({ type: "update-activity", id });
  });
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (stopped || !launcher || launcher.exitCode !== null) return;
    event.preventDefault();
    if (quitting) return;
    if (terminals?.count()) {
      const choice = dialog.showMessageBoxSync(window, {
        type: "question",
        title: "Stop terminal agents and quit?",
        message:
          "Your terminal agents are still open. Stop them and close Vizor? Saved CLI sessions can be resumed next time.",
        buttons: ["Keep working", "Stop agents and quit"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice !== 1) return;
    }
    quitting = true;
    startup?.dispose();
    window?.hide();
    void stopBackend().then(() => app.quit());
  });
  app
    .whenReady()
    .then(start)
    .catch(() => fail());
}
function fail() {
  if (failed || quitting) return;
  failed = true;
  dialog.showErrorBox(
    "Vizor couldn't start",
    "Your saved data has been kept. Close other copies of Vizor, then try again. If this continues, restore the matching .env and data folder from your backup or reinstall the app.\n\nYour data folder: " +
      paths.workspace,
  );
  app.quit();
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function openExternal(url) {
  const link = externalLink(url);
  if (link) shell.openExternal(link).catch(() => {});
}
async function start() {
  const resources = app.isPackaged
    ? join(process.resourcesPath, "vizor")
    : process.env.VIZOR_DESKTOP_BUNDLE;
  if (!resources) return fail();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  // Public update requests never inherit a developer or CI GitHub credential.
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const { NsisUpdater, CancellationToken } = require("electron-updater");
  const { UpdateManager } = require("./updater.cjs");
  const updateSource = require("./update-source.cjs");
  const updater = new NsisUpdater(updateSource.feed);
  const { DesktopTerminals } = require("./terminals.cjs");
  terminals = new DesktopTerminals({
    resources,
    home: paths.home,
    origin,
    emit: (value) => {
      if (window && !window.isDestroyed())
        window.webContents.send("vizor:terminal-event", value);
    },
  });
  updates = new UpdateManager({
    updater,
    source: updateSource,
    currentVersion: app.getVersion(),
    home: paths.shell,
    publish: (state) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(
        "vizor-automatic-updates",
      );
      if (item) item.checked = state.automatic;
      if (window && !window.isDestroyed())
        window.webContents.send("vizor:update-state", state);
    },
    activity,
    stopBackend,
    makeToken: () => new CancellationToken(),
    disabled: !app.isPackaged || process.env.VIZOR_DISABLE_UPDATES === "1",
  });
  function trusted(event) {
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !localNavigation(event.senderFrame.url, origin)
    )
      throw new Error("Untrusted desktop request");
  }
  ipcMain.handle("vizor:update-state", (event) => {
    trusted(event);
    return updates.snapshot();
  });
  ipcMain.handle("vizor:startup-ready", (event) => {
    trusted(event);
    return startup?.finish();
  });
  ipcMain.handle("vizor:terminal", (event, action, args) => {
    trusted(event);
    if (process.platform !== "win32")
      throw Error("Windows desktop is required");
    return terminals.request(action, args);
  });
  ipcMain.handle("vizor:terminal-folder", async (event) => {
    trusted(event);
    await terminals.ready();
    const result = await dialog.showOpenDialog(window, {
      title: "Choose agent project",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("vizor:update-check", (event) => {
    trusted(event);
    return updates.check();
  });
  ipcMain.handle("vizor:update-automatic", (event, enabled) => {
    trusted(event);
    return updates.automatic(enabled);
  });
  ipcMain.handle("vizor:update-restart", (event) => {
    trusted(event);
    return updates.restart();
  });
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback) =>
    callback(
      permission === "clipboard-sanitized-write" &&
        localNavigation(contents.getURL(), origin),
    ),
  );
  ses.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      permission === "clipboard-sanitized-write" &&
      localNavigation(requestingOrigin, origin),
  );
  ses.on("will-download", (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel:
        !localNavigation(details.url, origin) &&
        !details.url.startsWith("devtools:"),
    }),
  );
  ses.webRequest.onHeadersReceived((details, callback) =>
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'self'",
        ],
      },
    }),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open your data folder",
            click: () => shell.openPath(paths.workspace),
          },
          { type: "separator" },
          { role: "quit", label: "Quit Vizor" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Help",
        submenu: [
          { label: "Check for updates", click: () => void updates.check() },
          {
            label: "Automatic updates",
            id: "vizor-automatic-updates",
            type: "checkbox",
            checked: updates.snapshot().automatic,
            click: (item) => {
              void updates
                .automatic(item.checked)
                .catch(() =>
                  dialog.showErrorBox(
                    "Update preference",
                    "The update preference couldn't be saved. Please try again.",
                  ),
                );
            },
          },
          { label: "Restart to update", click: () => void updates.restart() },
          { type: "separator" },
          {
            label: "Vizor guide",
            click: () =>
              openExternal(
                "https://github.com/colinosbo/vizor/blob/main/WINDOWS.md",
              ),
          },
        ],
      },
    ]),
  );
  window = new BrowserWindow({
    title: "Vizor",
    width: 1400,
    height: 920,
    minWidth: 390,
    minHeight: 580,
    backgroundColor: "#171717",
    show: false,
    icon: join(__dirname, "icon.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: false,
    },
  });
  startup = require("./startup.cjs").createStartup(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!localNavigation(url, origin)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("render-process-gone", () => {
    if (!quitting) fail();
  });
  window.on("page-title-updated", (event) => event.preventDefault());
  window.on("closed", () => {
    window = undefined;
  });
  window.on("close", (event) => {
    if (!quitting && terminals?.count()) {
      event.preventDefault();
      app.quit();
    }
  });
  const environment = {
    ...process.env,
    VIZOR_WORKSPACE: paths.workspace,
    APP_ORIGIN: origin,
    NEXT_TELEMETRY_DISABLED: "1",
    CHECKPOINT_DISABLE: "1",
    VIZOR_TERMINALS: "1",
  };
  // Installed workspaces always use their own persistent configuration, not a developer's shell variables.
  for (const key of [
    "MASTER_KEY",
    "DATABASE_URL",
    "SELF_HOST",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "VIZOR_DESKTOP_BUNDLE",
  ])
    delete environment[key];
  launcher = spawn(
    join(resources, "runtime/node.exe"),
    [join(resources, "portable-launch.mjs"), "--desktop", "--no-open"],
    {
      cwd: resources,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const timeout = setTimeout(fail, 45000);
  timeout.unref();
  launcher.once("error", () => {
    clearTimeout(timeout);
    fail();
  });
  launcher.once("exit", () => {
    clearTimeout(timeout);
    stopped = true;
    if (quitting) app.quit();
    else if (!updates?.installing) fail();
  });
  launcher.on("message", (message) => {
    if (
      message?.type === "update-activity" &&
      activityRequests.has(message.id)
    ) {
      const done = activityRequests.get(message.id);
      activityRequests.delete(message.id);
      done(
        Number.isSafeInteger(message.active) && message.active >= 0
          ? message.active
          : null,
      );
      return;
    }
    if (message?.type !== "ready" || message.origin !== origin || quitting)
      return;
    clearTimeout(timeout);
    window
      .loadURL(origin)
      .then(() => {
        updates.start();
        // Reveal even when workspace hydration or its request fails to settle.
        const reveal = setTimeout(() => void startup?.finish(), 15000);
        reveal.unref();
        window.once("closed", () => clearTimeout(reveal));
      })
      .catch(() => fail());
  });
}
