import { test, expect } from "@playwright/test";

test("subscription Orchestrator setup and composer work without a provider key", async ({
  page,
}) => {
  const existing = await (await page.request.get("/api/workspace")).json();
  let configured = false;
  const coordinator = {
    id: "subscription-ui-fixture",
    name: "Orchestrator",
    engine: "api",
    provider: "anthropic",
    orchestratorMode: "subscription",
    model: "sonnet",
    systemPrompt: "Coordinate scoped work.",
    temperature: 0.4,
    maxTokens: 2048,
    color: "blue",
    icon: "spark",
    paused: false,
    archived: false,
    demo: false,
    kind: "orchestrator",
    conversation: {
      id: "subscription-conversation",
      activeRunId: null,
      messages: Array.from({ length: 35 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 ? "assistant" : "user",
        text: `Earlier message ${index} with enough content to fill the conversation.`,
        status: "complete",
        createdAt: new Date(2026, 0, 1, 0, index).toISOString(),
      })),
      runs: [],
    },
  };
  await page.route("**/api/workspace", (route) =>
    route.fulfill({
      json: {
        ...existing,
        subscriptionAvailable: true,
        agents: [],
        proposals: [],
        terminalDispatches: [],
        pendingProposalCount: 0,
        providers: existing.providers.map((provider: any) => ({
          ...provider,
          connected: false,
          last4: null,
        })),
        orchestrator: configured ? coordinator : null,
      },
    }),
  );
  await page.route("**/api/orchestrator", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON()).toMatchObject({
      orchestratorMode: "subscription",
      provider: "anthropic",
      model: "sonnet",
    });
    configured = true;
    await route.fulfill({ json: { id: coordinator.id } });
  });
  await page.goto("/");
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await page.getByRole("button", { name: "Mute notifications" }).click();
  await expect(
    page.getByRole("button", { name: "Unmute notifications" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".startup-intro")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Unmute notifications" }),
  ).toBeVisible();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Orchestrator/ })
    .click();
  await page
    .getByRole("button", { name: "Set up orchestrator", exact: true })
    .click();
  await expect(
    page.getByLabel("Orchestrator connection", { exact: true }),
  ).toHaveValue("subscription");
  await expect(page.getByLabel("Orchestrator subscription model")).toHaveValue(
    "sonnet",
  );
  await expect(
    page.getByText("No API key or API billing fallback.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save orchestrator", exact: true })
    .click();
  await expect(
    page.getByLabel("Message Orchestrator", { exact: true }),
  ).toBeEnabled();
  const chat = page.getByRole("log", {
    name: "Conversation with Orchestrator",
  });
  await expect
    .poll(() =>
      chat.evaluate(
        (area) => area.scrollHeight - area.scrollTop - area.clientHeight,
      ),
    )
    .toBeLessThan(5);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Agent board/ })
    .click();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Orchestrator/ })
    .click();
  await expect
    .poll(() =>
      chat.evaluate(
        (area) => area.scrollHeight - area.scrollTop - area.clientHeight,
      ),
    )
    .toBeLessThan(5);
  await expect(page.locator(".coordinator-panel")).not.toContainText(
    "Connect Claude in API keys",
  );
  await page
    .getByRole("button", { name: "Orchestrator settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Set up Claude subscription" }),
  ).toBeVisible();
});
