const { app, BrowserWindow, Menu } = require("electron");
const { createStartup } = require("../../desktop/startup.cjs");
const { join } = require("node:path");
app.setPath("userData", process.env.VIZOR_STARTUP_TEST_HOME);
Menu.setApplicationMenu(null);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: "#171717",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  globalThis.fixtureWindow = window;
  globalThis.fixtureStartup = createStartup(window);
  globalThis.createFixtureStartup = createStartup;
  await window.loadURL(
    "data:text/html," +
      encodeURIComponent(
        '<html><body style="background:#242424;color:#f0e9df;font:22px Segoe UI;margin:0;padding:80px"><h1>Workspace ready</h1></body></html>',
      ),
  );
});
app.on("window-all-closed", () => app.quit());
