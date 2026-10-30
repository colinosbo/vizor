import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
test("onboarding has labelled controls, contrast, visible keyboard focus and a narrow layout", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Connect your API" }),
  ).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Vizor home" })).toBeFocused();
  expect(
    await page
      .getByRole("link", { name: "Vizor home" })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe("solid");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const mobile = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    mobile.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.getByRole("button", { name: "Open navigation" }),
  ).toBeVisible();
});
