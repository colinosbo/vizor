import { test, expect } from "@playwright/test";
test("desktop update notices remain usable on narrow screens and defer a busy restart", async ({
  page,
}) => {
  await page.addInitScript(() => {
    type State = {
      state: string;
      currentVersion: string;
      automatic: boolean;
      version?: string;
      message?: string;
    };
    const initial: State = {
      state: "ready",
      currentVersion: "0.8.0",
      version: "0.8.1",
      automatic: true,
    };
    let listener: ((state: State) => void) | undefined;
    window.vizorDesktop = {
      getUpdateState: async () => initial,
      checkForUpdates: async () => initial,
      setAutomaticUpdates: async () => initial,
      restartToUpdate: async () => {
        listener?.({
          ...initial,
          message: "Finish or stop the current reply before restarting.",
        });
        return { ok: false, reason: "busy" };
      },
      onUpdateState: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const banner = page.locator(".desktop-update-banner");
  await expect(banner).toContainText("It will install when you close the app.");
  await banner.getByRole("button", { name: "Restart now" }).click();
  await expect(banner).toContainText("Finish or stop the current reply");
  expect(
    await banner.evaluate((element) => element.getBoundingClientRect().right),
  ).toBeLessThanOrEqual(390);
  await banner.getByRole("button", { name: "Dismiss update message" }).click();
  await expect(banner).toHaveCount(0);
});
test("the regular browser app exposes no desktop update control", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".desktop-update-banner")).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.vizorDesktop)).toBe(
    "undefined",
  );
});
