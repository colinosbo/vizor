import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
test.describe.serial("local workspace with mock Anthropic transport", () => {
  test("onboarding, persistent chat, settings, edits, cancellation and key lifecycle", async ({
    page,
  }) => {
    const outgoing: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => outgoing.push(request.url()));
    mkdirSync("verification", { recursive: true });
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Your ideas/ }),
    ).toBeVisible();
    await page.screenshot({
      path: "verification/onboarding-desktop.png",
      fullPage: true,
    });
    await page
      .getByLabel("Your Anthropic API key")
      .fill("sk-ant-invalid-fixture-key");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.locator(".error-banner")).toContainText("authenticate");
    await expect(page.getByLabel("Your Anthropic API key")).toHaveValue("");
    await page
      .getByLabel("Your Anthropic API key")
      .fill("sk-ant-fixture-valid-1234");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("•••• •••• •••• 1234")).toBeVisible();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(
      page.getByRole("heading", { name: "What’s on your mind?" }),
    ).toBeVisible();
    await page.screenshot({
      path: "verification/workspace-desktop.png",
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      accessibility.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    await page.getByRole("button", { name: "Agent settings" }).click();
    await page
      .getByLabel("Agent name", { exact: true })
      .fill("Project partner");
    await page
      .getByLabel(/^System prompt/)
      .fill("Help me build useful things. Be concrete.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("heading", { name: "Project partner" }),
    ).toBeVisible();
    await page
      .getByLabel("Message Project partner", { exact: true })
      .fill("Help me plan my next project");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("button", { name: "Stop response" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Regenerate response" }),
    ).toBeVisible();
    await expect(page.getByRole("log")).toContainText(
      "Make the next step clear",
    );
    await expect(page.locator("pre code")).toContainText("nextStep");
    expect(outgoing.filter((url) => url.includes("tracker.invalid"))).toEqual(
      [],
    );
    await expect(page.locator(".markdown img")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("log")).toContainText(
      "Help me plan my next project",
    );
    await page.getByRole("button", { name: "Regenerate response" }).click();
    await expect(
      page.getByRole("button", { name: "Stop response" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Regenerate response" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit message" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByLabel("Message", { exact: true })
      .fill("A revised project brief");
    await page.getByRole("button", { name: "Replace & resend" }).click();
    await expect(
      page.getByRole("button", { name: "Regenerate response" }),
    ).toBeVisible();
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(page.getByRole("log")).not.toContainText(
      "Help me plan my next project",
    );
    await page
      .getByLabel("Message Project partner", { exact: true })
      .fill("[long] Keep going");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("log")).toContainText(
      "This is a partial response",
    );
    await page.getByRole("button", { name: "Stop response" }).click();
    await expect(page.getByText("Stopped · partial response")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await page.screenshot({
      path: "verification/conversation-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "verification/conversation-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "API keys", exact: true }).click();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await page
      .getByLabel("New Anthropic API key")
      .fill("sk-ant-invalid-replacement");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.locator(".error-banner")).toContainText("authenticate");
    await page.getByRole("button", { name: "Cancel replacement" }).click();
    await expect(page.getByText("•••• •••• •••• 1234")).toBeVisible();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await page
      .getByLabel("New Anthropic API key")
      .fill("sk-ant-fixture-replaced-5678");
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByText("•••• •••• •••• 5678")).toBeVisible();
    await page.getByRole("button", { name: "Remove key", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove key", exact: true })
      .click();
    await expect(page.getByLabel("Your Anthropic API key")).toBeVisible();
    await page.screenshot({
      path: "verification/onboarding-mobile.png",
      fullPage: true,
    });
    expect(pageErrors).toEqual([]);
  });
  test("keyboard access, provider errors and model fallback", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByLabel("Your Anthropic API key")
      .fill("sk-ant-fixture-valid-1234");
    await page.getByRole("button", { name: "Test connection" }).click();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page
      .getByLabel("Message Project partner", { exact: true })
      .fill("[error] test upstream outage");
    await page
      .getByLabel("Message Project partner", { exact: true })
      .press("Enter");
    await expect(page.locator(".error-banner")).toContainText(
      "temporarily unavailable",
    );
    await expect(
      page.getByRole("button", { name: "Regenerate response" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit message" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("button", { name: "API keys", exact: true }).click();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    await page
      .getByLabel("New Anthropic API key")
      .fill("sk-ant-fixture-valid-1234");
    await page.getByRole("button", { name: "Test connection" }).click();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page.route("**/api/providers/anthropic/models", (route) =>
      route.fulfill({
        json: {
          fallback: true,
          message: "Claude temporarily unavailable",
          models: [
            {
              id: "claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
              temperature: false,
            },
          ],
        },
      }),
    );
    await page.getByRole("button", { name: "Agent settings" }).click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText(/Fallback list/)).toBeVisible();
    await page.screenshot({
      path: "verification/error-and-partial.png",
      fullPage: true,
    });
  });
});
