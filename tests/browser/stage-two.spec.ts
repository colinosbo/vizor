import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
const evidenceRoot = process.env.VIZOR_VERIFICATION_DIR ?? "verification";
test("both providers, concurrent live observers, saved layouts, templates and lifecycle", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  mkdirSync(`${evidenceRoot}/stage-two`, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = (name: string) =>
    name === "Create agent"
      ? page
          .getByRole("dialog", { name: "New agent", exact: true })
          .getByRole("button", { name, exact: true })
      : page.getByRole("button", { name, exact: true });
  const panel = (name: string) =>
    page.getByRole("region", { name: `${name} panel`, exact: true });
  const state = async () => (await page.request.get("/api/workspace")).json();
  await page.goto("/");
  await page
    .getByLabel("Your OpenAI API key")
    .fill("sk-openai-fixture-valid-1234");
  await page
    .locator('[data-provider="openai"]')
    .getByRole("button", { name: "Test connection" })
    .click();
  await expect(
    page
      .locator('[data-provider="openai"]')
      .getByText("Connected", { exact: true }),
  ).toBeVisible();
  await button("Open workspace").click();
  await button("Agent settings").click();
  await page.getByLabel("Agent name", { exact: true }).fill("GPT partner");
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue(
    "openai",
  );
  await button("Save changes").click();
  await page
    .getByLabel("Message GPT partner", { exact: true })
    .fill("A quick OpenAI check");
  await button("Send message").click();
  await expect(page.getByRole("log")).toContainText("An OpenAI response to");
  await expect(button("Regenerate response")).toBeVisible();
  expect(
    (await state()).providers.find((p: { id: string }) => p.id === "anthropic")
      .connected,
  ).toBe(false);
  await button("API keys").click();
  await page
    .getByLabel("Your Anthropic API key")
    .fill("sk-ant-fixture-valid-5678");
  await page
    .locator('[data-provider="anthropic"]')
    .getByRole("button", { name: "Test connection" })
    .click();
  await expect(
    page
      .locator('[data-provider="anthropic"]')
      .getByText("Connected", { exact: true }),
  ).toBeVisible();
  await button("Open workspace").click();
  await button("New agent").click();
  await page.getByLabel("Agent name", { exact: true }).fill("Writer");
  await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
  await page.getByLabel("Colour", { exact: true }).selectOption("amber");
  await button("Create agent").click();
  await expect(button("2-up layout")).toHaveAttribute("aria-pressed", "true");
  const observer = await context.newPage();
  await observer.goto("/");
  await expect(
    observer.getByRole("region", { name: "Writer panel", exact: true }),
  ).toBeVisible();
  await panel("Writer")
    .getByLabel("Message Writer", { exact: true })
    .fill("[long] Claude concurrent run");
  await panel("Writer").getByRole("button", { name: "Send message" }).click();
  await panel("GPT partner")
    .getByLabel("Message GPT partner", { exact: true })
    .fill("[long] OpenAI concurrent run");
  await panel("GPT partner")
    .getByRole("button", { name: "Send message" })
    .click();
  await expect(
    observer
      .getByRole("region", { name: "Writer panel", exact: true })
      .getByRole("log"),
  ).toContainText("This is a partial response");
  await expect(
    observer
      .getByRole("region", { name: "GPT partner panel", exact: true })
      .getByRole("log"),
  ).toContainText("OpenAI is streaming independently");
  await page.screenshot({
    path: `${evidenceRoot}/stage-two/concurrent-desktop.png`,
    fullPage: true,
  });
  await button("Collapse Writer").click();
  await expect(button("Expand Writer")).toBeVisible();
  await button("Tabbed layout").click();
  await button("Expand Writer").click();
  await expect(
    panel("Writer").getByRole("button", { name: "Stop response" }),
  ).toBeVisible();
  await button("2-up layout").click();
  await panel("Writer").getByRole("button", { name: "Stop response" }).click();
  await expect(
    panel("Writer").getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  await expect(
    panel("GPT partner").getByRole("button", { name: "Stop response" }),
  ).toBeVisible();
  await panel("GPT partner")
    .getByRole("button", { name: "Stop response" })
    .click();
  await expect(
    panel("GPT partner").getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  await observer.close();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    a11y.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
  const first = page
    .locator(".react-grid-item")
    .filter({ has: panel("GPT partner") });
  const start = await first
      .getByRole("button", { name: "Move GPT partner panel" })
      .boundingBox(),
    target = await panel("Writer").boundingBox();
  await page.mouse.move(
    start!.x + start!.width / 2,
    start!.y + start!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 30, {
    steps: 12,
  });
  await page.mouse.up();
  await expect
    .poll(async () => (await state()).layout.layouts["2"]?.length ?? 0)
    .toBe(2);
  const gptId = (await state()).agents.find(
    (a: { name: string }) => a.name === "GPT partner",
  ).id;
  expect(
    (await state()).layout.layouts["2"].some(
      (item: { i: string; x: number; y: number }) =>
        item.i === gptId && (item.x !== 0 || item.y !== 0),
    ),
  ).toBe(true);
  const previous = JSON.stringify((await state()).layout.layouts["2"]);
  await first.getByRole("button", { name: "Resize agent panel" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => JSON.stringify((await state()).layout.layouts["2"]))
    .not.toBe(previous);
  const handle = first.getByRole("button", { name: "Resize agent panel" });
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  const beforePointerResize = JSON.stringify(
    (await state()).layout.layouts["2"],
  );
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2,
    box!.y + box!.height / 2 - 65,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => JSON.stringify((await state()).layout.layouts["2"]))
    .not.toBe(beforePointerResize);
  await button("Pin GPT partner").click();
  await button("Collapse Writer").click();
  await expect(button("Expand Writer")).toBeVisible();
  await expect(page.getByText("Layout saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(button("Unpin GPT partner")).toBeVisible();
  await expect(button("Expand Writer")).toBeVisible();
  await button("Expand Writer").click();
  await button("Agent settings for Writer").click();
  await button("Save as template").click();
  await page.getByLabel("Template name", { exact: true }).fill("Writing role");
  await button("Save template").click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Templates/ }).click();
  await expect(
    page.getByRole("heading", { name: "Writing role", exact: true }),
  ).toBeVisible();
  await button("Use template").click();
  await button("Create agent").click();
  await button("4-up layout").click();
  await button("Agent settings for Writing role").click();
  await button("Duplicate agent").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".agent-panel")).toHaveCount(4);
  await page.screenshot({
    path: `${evidenceRoot}/stage-two/four-agent-desktop.png`,
    fullPage: true,
  });
  await button("Agent settings for Writing role copy").click();
  await page.getByLabel("Agent name", { exact: true }).fill("Research analyst");
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await button("Save changes").click();
  await button("Agent settings for Research analyst").click();
  await button("Archive agent").click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /Archive/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Research analyst", exact: true }),
  ).toBeVisible();
  await button("Restore agent").click();
  await page.getByRole("button", { name: /Conversations/ }).click();
  await button("Agent settings for Writer").click();
  await button("Pause agent").click();
  await expect(button("Resume agent")).toBeVisible();
  await button("Resume agent").click();
  await page.keyboard.press("Escape");
  await button("6-up layout").click();
  await expect(page.locator(".agent-panel")).toHaveCount(4);
  await button("Tabbed layout").click();
  await expect(
    page.getByRole("tablist", { name: "Agent conversations" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Writer", exact: true }).click();
  await expect(panel("Writer")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${evidenceRoot}/stage-two/tabs-mobile.png`,
    fullPage: true,
  });
  await button("4-up layout").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${evidenceRoot}/stage-two/grid-mobile.png`,
    fullPage: true,
  });
  expect(
    (await state()).agents.filter((a: { archived: boolean }) => !a.archived),
  ).toHaveLength(4);
  expect((await state()).templates).toHaveLength(1);
  expect(errors).toEqual([]);
});
