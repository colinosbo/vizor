const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

// The mascot floats over the desktop while the normal app loads hidden.
// Separate windows preserve the app's normal resizing and window controls.
function createStartup(window) {
  const splash = new BrowserWindow({
    ...window.getContentBounds(),
    title: "Opening Vizor",
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      partition: "vizor-startup",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
    },
  });
  splash.setMenu(null);
  const contents = splash.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith("file:") }),
  );
  let disposed = false;
  let cancelled = false;
  let finishing;
  const align = () => {
    if (!splash.isDestroyed()) splash.setBounds(window.getContentBounds());
  };
  window.on("resize", align);
  window.on("move", align);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeListener("resize", align);
    window.removeListener("move", align);
    if (!splash.isDestroyed()) splash.destroy();
  };
  window.once("closed", () => {
    cancelled = true;
    dispose();
  });
  splash.on("close", (event) => {
    if (!disposed) {
      event.preventDefault();
      window.close();
    }
  });
  const loaded = contents
    .loadFile(
      join(
        app.isPackaged
          ? join(process.resourcesPath, "intro")
          : join(__dirname, "../public/intro"),
        "index.html",
      ),
    )
    .then(() => {
      if (!disposed && !window.isDestroyed()) {
        align();
        splash.show();
      }
    })
    .catch(dispose);
  contents.on("render-process-gone", dispose);

  async function reveal(reduced) {
    if (cancelled || window.isDestroyed()) return;
    await window.webContents
      .executeJavaScript(
        "document.documentElement.classList.add('startup-revealing')",
      )
      .catch(() => {});
    if (cancelled || window.isDestroyed()) return;
    window.setOpacity(0);
    window.showInactive();
    if (!splash.isDestroyed()) splash.moveTop();
    const start = performance.now();
    await new Promise((resolve) => {
      function tick() {
        if (disposed || window.isDestroyed()) return resolve();
        const progress = Math.min(
          1,
          (performance.now() - start) / (reduced ? 180 : 650),
        );
        window.setOpacity(1 - (1 - progress) ** 3);
        if (progress === 1) resolve();
        else setTimeout(tick, 16);
      }
      tick();
    });
  }
  return {
    finish() {
      if (finishing) return finishing;
      finishing = (async () => {
        await loaded;
        if (cancelled || window.isDestroyed()) return;
        align();
        let timeout;
        try {
          await Promise.race([
            (async () => {
              if (!contents.isDestroyed())
                await contents.executeJavaScript("window.vizorIntro.prepare()");
              if (cancelled || window.isDestroyed()) return;
              const reduced =
                contents.isDestroyed() ||
                (await contents.executeJavaScript(
                  "matchMedia('(prefers-reduced-motion: reduce)').matches",
                ));
              await Promise.all([
                reveal(reduced),
                contents.isDestroyed()
                  ? Promise.resolve()
                  : contents.executeJavaScript("window.vizorIntro.finish()"),
              ]);
            })(),
            new Promise((resolve) => {
              timeout = setTimeout(resolve, 6000);
            }),
          ]);
        } catch {
          /* A decoration must never block the workspace. */
        } finally {
          clearTimeout(timeout);
          if (!cancelled && !window.isDestroyed()) {
            await window.webContents
              .executeJavaScript(
                "document.documentElement.classList.add('startup-revealing')",
              )
              .catch(() => {});
            window.setOpacity(1);
            window.show();
            window.webContents.focus();
          }
          dispose();
        }
      })();
      return finishing;
    },
    dispose() {
      cancelled = true;
      dispose();
    },
  };
}
module.exports = { createStartup };
