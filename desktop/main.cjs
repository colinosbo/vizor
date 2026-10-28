const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
  session,
  nativeTheme,
} = require("electron");
const { spawn } = require("node:child_process");
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
    quitting = true;
    window?.hide();
    if (launcher.connected) launcher.send({ type: "stop" });
    const timer = setTimeout(() => {
      launcher.kill();
      stopped = true;
      app.quit();
    }, 8000);
    timer.unref();
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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: false,
    },
  });
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
  const environment = {
    ...process.env,
    VIZOR_WORKSPACE: paths.workspace,
    APP_ORIGIN: origin,
    NEXT_TELEMETRY_DISABLED: "1",
    CHECKPOINT_DISABLE: "1",
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
    else fail();
  });
  launcher.on("message", (message) => {
    if (message?.type !== "ready" || message.origin !== origin || quitting)
      return;
    clearTimeout(timeout);
    window
      .loadURL(origin)
      .then(() => {
        window.show();
        window.focus();
      })
      .catch(() => fail());
  });
}
