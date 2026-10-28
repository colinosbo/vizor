import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
test("native orchestration, human approval, audit history and provider spending controls", async ({
  page,
}) => {
  test.setTimeout(120000);
  mkdirSync("verification/orchestration", { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const button = (name: string) =>
    page.getByRole("button", { name, exact: true });
  const state = async () => (await page.request.get("/api/workspace")).json();
  const navigate = async (name: string) => {
    if (await button("Open navigation").isVisible())
      await button("Open navigation").click();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: new RegExp(`^${name}`) })
      .click();
    if (await button("Open navigation").isVisible())
      await expect
        .poll(() =>
          page
            .locator(".sidebar")
            .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
  };
  const assertA11y = async () => {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  };
  await page.goto("/");
  await page
    .getByLabel("Your Anthropic API key")
    .fill("sk-ant-orchestrator-fixture-1234");
  await page
    .locator('[data-provider="anthropic"]')
    .getByRole("button", { name: "Test connection" })
    .click();
  await button("Open workspace").click();
  await button("Agent settings").click();
  await page.getByLabel("Agent name", { exact: true }).fill("Writer");
  await button("Save changes").click();
  const writerId = (await state()).agents[0].id;
  await navigate("Orchestrator");
  await expect(page.getByText("Autopilot off", { exact: true })).toBeVisible();
  await button("Set up orchestrator").click();
  await page.getByLabel("Maximum output tokens per model call").fill("512");
  await button("Save orchestrator").click();
  await expect(
    page.getByLabel("Message Orchestrator", { exact: true }),
  ).toBeVisible();
  const ask = async (text: string) => {
    await page.getByLabel("Message Orchestrator", { exact: true }).fill(text);
    await button("Send message").click();
    await expect(button("Regenerate response")).toBeVisible();
  };
  await button("Summarize progress").click();
  await expect(button("Regenerate response")).toBeVisible();
  expect((await state()).pendingProposalCount).toBe(0);
  await button("Draft next steps").click();
  const card = page.getByRole("article", {
    name: "Send a message proposal",
    exact: true,
  });
  await expect(card).toBeVisible();
  await expect(button("Regenerate response")).toBeVisible();
  expect((await state()).agents[0].conversation.messages).toHaveLength(0);
  expect((await state()).autopilot).toBe(false);
  await assertA11y();
  await page.screenshot({
    path: "verification/orchestration/orchestrator-desktop.png",
    fullPage: true,
  });
  await card.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Proposal message")
    .fill("Please review the plan I approved and list one next step.");
  await button("Save draft").click();
  await expect(card).toContainText("Please review the plan I approved");
  const proposal = (await state()).proposals.find(
    (p: { status: string }) => p.status === "pending",
  );
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(async () => (await state()).agents[0].conversation.runs[0]?.status)
    .toBe("complete");
  const duplicate = await page.request.post(
    `/api/proposals/${proposal.id}/approve`,
    {
      headers: { origin: "http://127.0.0.1:3104" },
      data: { version: proposal.version },
    },
  );
  expect(await duplicate.json()).toMatchObject({ alreadyReviewed: true });
  expect((await state()).agents[0].conversation.runs).toHaveLength(1);
  await navigate("Conversations");
  await expect(page.getByRole("log")).toContainText(
    /Orchestrator.*Approved by you/,
  );
  await expect(page.getByRole("log")).toContainText(
    "Please review the plan I approved",
  );
  await navigate("Orchestrator");
  await ask("Create a reviewer agent for my work.");
  const create = page.getByRole("article", {
    name: "Create an agent proposal",
    exact: true,
  });
  await expect(create).toBeVisible();
  expect((await state()).agents).toHaveLength(1);
  await create.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Agent name", { exact: true })
    .fill("Quality reviewer");
  await button("Save draft").click();
  await create.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await state()).agents.length).toBe(2);
  await ask("Rename the writer.");
  await ask("Pause the writer.");
  await navigate("Proposals");
  await expect(page.locator(".proposal-card")).toHaveCount(2);
  await button("Approve 2").click();
  await expect.poll(async () => (await state()).pendingProposalCount).toBe(0);
  expect(
    (await state()).agents.find((a: { id: string }) => a.id === writerId),
  ).toMatchObject({ name: "Lead writer", paused: true });
  await navigate("Orchestrator");
  await ask("Archive the writer.");
  await page
    .getByRole("article", { name: "Archive an agent proposal" })
    .getByRole("button", { name: "Reject proposal" })
    .click();
  expect(
    (await state()).agents.find((a: { id: string }) => a.id === writerId)
      .archived,
  ).toBe(false);
  // Verify the same orchestration path with OpenAI's native function-call events.
  await navigate("API keys");
  await page
    .getByLabel("Your OpenAI API key")
    .fill("sk-openai-orchestrator-fixture-5678");
  await page
    .locator('[data-provider="openai"]')
    .getByRole("button", { name: "Test connection" })
    .click();
  await expect(
    page
      .locator('[data-provider="openai"]')
      .getByText("Connected", { exact: true }),
  ).toBeVisible();
  await navigate("Orchestrator");
  await button("Orchestrator settings").click();
  await page.getByLabel("Orchestrator provider").selectOption("openai");
  await button("Save orchestrator").click();
  await ask("Draft a useful next step message.");
  await expect(card).toBeVisible();
  expect(
    (await state()).agents.find((a: { id: string }) => a.id === writerId)
      .conversation.runs,
  ).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(844);
  await expect(page.getByText("Autopilot off", { exact: true })).toBeVisible();
  await page
    .getByLabel("Message Orchestrator", { exact: true })
    .scrollIntoViewIfNeeded();
  await expect(page.locator(".toast")).not.toBeVisible({ timeout: 10000 });
  await expect(
    page.getByLabel("Message Orchestrator", { exact: true }),
  ).toBeInViewport();
  await assertA11y();
  await page.screenshot({
    path: "verification/orchestration/orchestrator-mobile.png",
    fullPage: true,
  });
  await navigate("Proposals");
  await page.screenshot({
    path: "verification/orchestration/proposals-mobile.png",
    fullPage: true,
  });
  await navigate("Audit history");
  await expect(page.locator(".audit-list")).toContainText("Approved by you");
  await expect(page.locator(".audit-list")).toContainText("Orchestrator");
  await assertA11y();
  await page.screenshot({
    path: "verification/orchestration/audit-mobile.png",
    fullPage: true,
  });
  await navigate("Spending limits");
  const claudeBudget = page.getByRole("region", {
    name: "Claude spending limit",
    exact: true,
  });
  await claudeBudget.getByLabel("Enable monthly spending limit").check();
  await claudeBudget.getByLabel("Monthly limit (USD)").fill("1");
  await claudeBudget
    .getByText("Reconcile earlier usage", { exact: true })
    .click();
  await claudeBudget.getByLabel("Opening balance (USD)").fill("0.80");
  await button("Save Claude limit").click();
  await expect(claudeBudget).toContainText("80% used or reserved");
  await page
    .locator(".spending-view")
    .evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Claude spending settings saved." }),
  ).not.toBeVisible({ timeout: 10000 });
  await page.screenshot({
    path: "verification/orchestration/budget-mobile.png",
    fullPage: true,
  });
  await assertA11y();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator(".spending-view")
    .evaluate((el) => el.scrollTo({ top: 0 }));
  await page.screenshot({
    path: "verification/orchestration/budget-desktop.png",
    fullPage: true,
  });
  await claudeBudget.getByLabel("Monthly limit (USD)").fill("0");
  await button("Save Claude limit").click();
  await expect(claudeBudget).toContainText("New generations are blocked");
  // A $0 budget blocks generation in the chat and connection-test routes.
  const reviewerId = (await state()).agents.find(
    (a: { name: string }) => a.name === "Quality reviewer",
  ).id;
  const blocked = await page.request.post(
    `/api/agents/${reviewerId}/messages`,
    {
      headers: { origin: "http://127.0.0.1:3104" },
      data: {
        clientId: crypto.randomUUID(),
        mode: "send",
        text: "This must be blocked",
      },
    },
  );
  expect(await blocked.text()).toContain("budget_exhausted");
  const blockedKey = await page.request.post("/api/providers/anthropic", {
    headers: { origin: "http://127.0.0.1:3104" },
    data: { key: "sk-ant-replacement-fixture-9999" },
  });
  expect(blockedKey.status()).toBe(409);
  expect(
    (await state()).providers.find((p: { id: string }) => p.id === "anthropic")
      .last4,
  ).toBe("1234");
  const openaiBudget = page.getByRole("region", {
    name: "ChatGPT spending limit",
    exact: true,
  });
  await openaiBudget.getByLabel("Enable monthly spending limit").check();
  await openaiBudget.getByLabel("Monthly limit (USD)").fill("0");
  await button("Save ChatGPT limit").click();
  await expect(openaiBudget).toContainText("New generations are blocked");
  await navigate("Orchestrator");
  await page
    .getByLabel("Message Orchestrator", { exact: true })
    .fill("This also must be blocked");
  await button("Send message").click();
  await expect(page.locator(".coordinator-panel")).toContainText(
    "monthly budget is exhausted",
  );
  await page.reload();
  expect((await state()).autopilot).toBe(false);
  expect(
    (await state()).budgets.every((b: { limit: number }) => b.limit === 0),
  ).toBe(true);
  expect((await state()).pendingProposalCount).toBe(1);
  await navigate("Audit history");
  await page.screenshot({
    path: "verification/orchestration/audit-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
