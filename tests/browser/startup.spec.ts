import { test, expect } from "@playwright/test";

test("the spinning character stays centered while accelerating and slowing down", async ({
  page,
}) => {
  await page.goto("/intro/index.html");
  const samples = await page.evaluate(() => {
    const animations = document.getAnimations();
    for (const animation of animations) animation.pause();
    const mascot = document.querySelector(".mascot")!;
    const scene = document.querySelector(".scene")!;
    const spin = animations.find(
      (animation) => (animation.effect as KeyframeEffect).target === mascot,
    )!;
    return [0, 150, 300, 450, 600, 750, 900, 1050, 1200, 1350, 1500, 1600].map(
      (time) => {
        for (const animation of animations) animation.currentTime = time;
        const body = mascot.getBoundingClientRect(),
          stage = scene.getBoundingClientRect();
        const pixels = [...document.querySelectorAll(".pixels rect")].map(
          (pixel) => pixel.getBoundingClientRect(),
        );
        const centerX = stage.x + stage.width / 2,
          centerY = stage.y + stage.height / 2;
        return {
          time,
          anchorDrift: Math.hypot(
            body.x + body.width / 2 - centerX,
            body.y + body.height / 2 - centerY,
          ),
          pixelDrift: Math.hypot(
            pixels.reduce((sum, pixel) => sum + pixel.x + pixel.width / 2, 0) /
              pixels.length -
              centerX,
            pixels.reduce((sum, pixel) => sum + pixel.y + pixel.height / 2, 0) /
              pixels.length -
              centerY,
          ),
          progress: spin.effect!.getComputedTiming().progress!,
        };
      },
    );
  });
  expect(Math.max(...samples.map((sample) => sample.anchorDrift))).toBeLessThan(
    0.25,
  );
  expect(Math.max(...samples.map((sample) => sample.pixelDrift))).toBeLessThan(
    8,
  );
  const speed = (first: number, last: number) =>
    (samples[last].progress - samples[first].progress) /
    (samples[last].time - samples[first].time);
  expect(speed(0, 2)).toBeLessThan(speed(4, 6));
  expect(speed(9, 11)).toBeLessThan(speed(4, 6));
});

test("floating artwork has no background or full-screen backplate", async ({
  page,
}) => {
  await page.goto("/intro/index.html");
  for (const selector of ["html", "body", ".intro", ".scene"]) {
    await expect(page.locator(selector)).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
  }
  await expect(page.locator(".curtain, .ambient")).toHaveCount(0);
  await expect(page.locator(".comet")).toHaveCount(3);
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("intro locks into the orange character and waits for the workspace before revealing it", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/workspace", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/");
  const intro = page.frameLocator(".startup-intro");
  await expect(intro.locator(".scope-label")).toHaveCSS("opacity", "1");
  await expect(intro.locator(".pixels rect").nth(30)).toHaveCSS(
    "fill",
    "rgb(233, 139, 87)",
  );
  await expect(page.locator(".app-shell")).toHaveAttribute("inert", "");
  await expect(intro.getByRole("button")).toHaveCount(0);
  await expect(page.locator("iframe.startup-intro")).toHaveCount(1);
  release();
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "API keys", exact: true }).click();
  await expect(page.locator(".startup-intro")).toHaveCount(0);
});

test("reduced motion uses the static orange mascot and a short fade", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/intro/index.html");
  await expect(page.locator(".pixels rect").first()).toHaveCSS(
    "fill",
    "rgb(233, 139, 87)",
  );
  expect(
    await page
      .locator(".mascot")
      .evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  await page.evaluate(() =>
    (
      window as unknown as { vizorIntro: { finish(): Promise<void> } }
    ).vizorIntro.finish(),
  );
  await expect(page.locator("body")).toHaveAttribute("data-complete", "true");
});

test("a workspace failure still reveals the recovery screen", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/workspace", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Workspace unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
});

test("missing intro assets cannot trap the application behind the overlay", async ({
  page,
}) => {
  await page.route("**/intro/intro.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".startup-intro")).toHaveCount(0, {
    timeout: 12000,
  });
  await expect(page.locator(".app-shell")).not.toHaveAttribute("inert", "");
});
