import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
const evidenceRoot = process.env.VIZOR_VERIFICATION_DIR ?? "verification";
test("approved task queue and persistent full auto switches", async ({
  page,
}) => {
  const headers = { origin: "http://127.0.0.1:3106" };
  await page.goto("/");
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await page.request.post("/api/providers/anthropic", {
    headers,
    data: { key: "sk-ant-orchestrator-fixture-1234" },
  });
  // Queue UI is exercised with a real local database; no CLI or paid provider is started.
  const response = await page.request.post("/api/agents", {
    headers,
    data: {
      name: "Queue test worker",
      engine: "api",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPrompt: "Follow the scoped assignment.",
      temperature: 0.2,
      maxTokens: 512,
      color: "blue",
      icon: "code",
    },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Approvals/ })
    .click();
  const queueSwitch = page.getByRole("switch", {
    name: "Run approved queue",
    exact: true,
  });
  const autoSwitch = page.getByRole("switch", {
    name: "Full auto approval",
    exact: true,
  });
  await expect(queueSwitch).toHaveAttribute("aria-checked", "false");
  await expect(autoSwitch).toHaveAttribute("aria-checked", "false");
  await autoSwitch.click();
  await expect(autoSwitch).toHaveAttribute("aria-checked", "true");
  await expect(queueSwitch).toHaveAttribute("aria-checked", "true");
  await autoSwitch.click();
  await expect(autoSwitch).toHaveAttribute("aria-checked", "false");
  await expect(queueSwitch).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByLabel("Queued task worker")
    .selectOption({ label: "Queue test worker" });
  await page
    .getByLabel("Queued task instructions")
    .fill(
      "Review the approved menu changes and report evidence. Do not edit files.",
    );
  await page.getByRole("button", { name: "Add to queue", exact: true }).click();
  const card = page
    .getByRole("article", { name: "Send a message proposal" })
    .filter({ hasText: "Review the approved menu changes" });
  await expect(card).toContainText("Queue paused.");
  await page.reload();
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Approvals/ })
    .click();
  await expect(card).toContainText("Review the approved menu changes");
  const issues = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(issues.violations.map((issue) => issue.id)).toEqual([]);
  mkdirSync(`${evidenceRoot}/task-queue`, { recursive: true });
  await page.screenshot({
    path: `${evidenceRoot}/task-queue/desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(autoSwitch).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${evidenceRoot}/task-queue/mobile.png`,
    fullPage: true,
  });
  await card.getByRole("button", { name: "Cancel queued task" }).click();
  await expect(card).toHaveCount(0);
  const state = await (await page.request.get("/api/workspace")).json();
  expect(state.autopilot).toBe(false);
  expect(state.queueEnabled).toBe(false);
});
