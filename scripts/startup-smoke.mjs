import assert from "node:assert/strict";
import { _electron } from "@playwright/test";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
const folder = resolve("artifacts", `startup-check-${randomUUID()}`);
mkdirSync(folder, { recursive: true });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
environment.VIZOR_STARTUP_TEST_HOME = folder;
const electron = await _electron.launch({
  executablePath: resolve("desktop/node_modules/electron/dist/electron.exe"),
  args: [resolve("tests/fixtures/startup-window.cjs")],
  env: environment,
  timeout: 30000,
});
try {
  await electron.firstWindow();
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const before = await electron.evaluate(({ BrowserWindow }) => {
    const main = globalThis.fixtureWindow;
    const splash = BrowserWindow.getAllWindows().find(
      (window) => window !== main,
    );
    globalThis.fixtureSplash = splash;
    return {
      mainVisible: main.isVisible(),
      splashVisible: splash.isVisible(),
      splashBounds: splash.getBounds(),
      mainBounds: main.getContentBounds(),
    };
  });
  assert.equal(
    before.mainVisible,
    false,
    "Main application stays hidden while mascot floats",
  );
  assert.equal(before.splashVisible, true);
  for (const key of ["x", "y", "width", "height"])
    assert(
      Math.abs(before.splashBounds[key] - before.mainBounds[key]) <= 2,
      `Aligned ${key}`,
    );
  const alpha = await electron.evaluate(async () => {
    const image = await globalThis.fixtureSplash.webContents.capturePage();
    const bitmap = image.toBitmap();
    let transparent = 0,
      opaque = 0;
    for (let i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] === 0) transparent++;
      if (bitmap[i] === 255) opaque++;
    }
    return {
      png: image.toPNG().toString("base64"),
      fractionTransparent: transparent / (bitmap.length / 4),
      opaque,
      cornerAlpha: bitmap[3],
    };
  });
  assert.equal(alpha.cornerAlpha, 0);
  assert(
    alpha.fractionTransparent > 0.9,
    "No background plate behind the floating mascot",
  );
  assert(alpha.opaque > 1000, "Mascot remains visible");
  writeFileSync(
    resolve(folder, "floating-native.png"),
    Buffer.from(alpha.png, "base64"),
  );
  await electron.evaluate(() =>
    globalThis.fixtureWindow.setContentSize(1000, 700),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  const resized = await electron.evaluate(() =>
    globalThis.fixtureSplash.getBounds(),
  );
  assert(Math.abs(resized.width - 1000) <= 2);
  assert(Math.abs(resized.height - 700) <= 2);
  await electron.evaluate(() => {
    globalThis.fixtureStartup.finish();
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const during = await electron.evaluate(() => ({
    mainVisible: globalThis.fixtureWindow.isVisible(),
    splashVisible: globalThis.fixtureSplash.isVisible(),
    opacity: globalThis.fixtureWindow.getOpacity(),
  }));
  assert(
    during.mainVisible && during.splashVisible,
    "Floating mascot and app overlap during handoff",
  );
  assert(
    during.opacity > 0 && during.opacity < 1,
    "Native application frame fades in",
  );
  await electron.evaluate(() => globalThis.fixtureStartup.finish());
  const after = await electron.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().length,
    opacity: globalThis.fixtureWindow.getOpacity(),
    visible: globalThis.fixtureWindow.isVisible(),
    focus: globalThis.fixtureWindow.webContents.isFocused(),
  }));
  assert.equal(after.windows, 1);
  assert.equal(after.opacity, 1);
  assert.equal(after.visible, true);
  // Missing artwork still shows the real app, and cancelling never reopens it.
  await electron.evaluate(async ({ BrowserWindow }) => {
    const fallback = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const startup = globalThis.createFixtureStartup(fallback);
    await fallback.loadURL("data:text/html,<h1>Recovery</h1>");
    const splash = BrowserWindow.getAllWindows().find(
      (candidate) =>
        candidate !== fallback && candidate !== globalThis.fixtureWindow,
    );
    await new Promise((resolve) =>
      splash.webContents.isLoading()
        ? splash.webContents.once("did-finish-load", resolve)
        : resolve(),
    );
    await splash.webContents.executeJavaScript("window.vizorIntro = undefined");
    await startup.finish();
    if (!fallback.isVisible() || fallback.getOpacity() !== 1)
      throw Error("Artwork failure blocked the application");
    fallback.destroy();
    const cancelled = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const cancelledStartup = globalThis.createFixtureStartup(cancelled);
    cancelledStartup.dispose();
    await cancelledStartup.finish();
    if (cancelled.isVisible()) throw Error("Cancelled intro reopened a window");
    cancelled.destroy();
  });
  console.log(
    JSON.stringify({
      pass: true,
      transparency: alpha.fractionTransparent,
      nativeFrameFade: true,
      resize: true,
      splashDisposed: true,
    }),
  );
} finally {
  await electron.close();
}
