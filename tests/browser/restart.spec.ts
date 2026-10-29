import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
test("real server restart preserves history and keys and recovers an interrupted generation", async ({
  page,
}) => {
  test.setTimeout(60000);
  const dbPath = `data/restart-${process.pid}.db`;
  const database = new Database(dbPath);
  database.pragma("journal_mode=WAL");
  for (const migration of readdirSync("prisma/migrations")
    .filter((name) => /^\d/.test(name))
    .sort())
    database.exec(
      readFileSync(`prisma/migrations/${migration}/migration.sql`, "utf8"),
    );
  database.close();
  const env = {
    ...process.env,
    SELF_HOST: "true",
    APP_ORIGIN: "http://127.0.0.1:3102",
    DATABASE_URL: `file:./${dbPath}`,
    MASTER_KEY: randomBytes(32).toString("base64"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  let child: ChildProcess | undefined;
  async function start() {
    child = spawn(
      process.execPath,
      [
        "--require",
        "./tests/fixtures/mock-anthropic.cjs",
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        "3102",
      ],
      { env, stdio: "ignore", windowsHide: true },
    );
    await expect
      .poll(
        async () => {
          try {
            return (await fetch("http://127.0.0.1:3102")).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15000 },
      )
      .toBe(200);
  }
  async function kill() {
    if (!child || child.exitCode !== null) return;
    const exiting = new Promise<void>((resolve) =>
      child!.once("exit", () => resolve()),
    );
    child.kill();
    await exiting;
  }
  try {
    await start();
    await page.goto("http://127.0.0.1:3102");
    await expect(page.locator(".startup-intro")).toHaveCount(0);
    await page
      .getByLabel("Your Anthropic API key")
      .fill("sk-ant-restart-fixture-1234");
    await page
      .locator('[data-provider="anthropic"]')
      .getByRole("button", { name: "Test connection" })
      .click();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page
      .getByLabel("Message My assistant", { exact: true })
      .fill("Saved before restart");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(
      page.getByRole("button", { name: "Regenerate response" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "2-up layout", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Pin My assistant", exact: true })
      .click();
    await expect(page.getByText("Layout saved", { exact: true })).toBeVisible();
    const apiHeaders = { origin: "http://127.0.0.1:3102" };
    const savedCoordinator = await page.request.patch(
      "http://127.0.0.1:3102/api/orchestrator",
      {
        headers: apiHeaders,
        data: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 512,
          temperature: 0.4,
        },
      },
    );
    expect(savedCoordinator.ok()).toBe(true);
    const draft = await page.request.post(
      "http://127.0.0.1:3102/api/orchestrator/messages",
      {
        headers: apiHeaders,
        data: {
          clientId: crypto.randomUUID(),
          mode: "send",
          text: "Rename the writer",
        },
      },
    );
    expect(await draft.text()).toContain("event: done");
    const savedState = await (
      await page.request.get("http://127.0.0.1:3102/api/workspace")
    ).json();
    const pendingId = savedState.proposals.find(
      (p: { status: string }) => p.status === "pending",
    ).id;
    expect(
      (
        await page.request.patch(
          "http://127.0.0.1:3102/api/budgets/anthropic",
          { headers: apiHeaders, data: { limit: 0.05 } },
        )
      ).ok(),
    ).toBe(true);
    await page
      .getByLabel("Message My assistant", { exact: true })
      .fill("[long] Crash recovery check");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("log")).toContainText(
      "This is a partial response",
    );
    // Crash only after the checkpoint is durable; the UI can lead it by 250 ms.
    await expect
      .poll(() => {
        const check = new Database(dbPath, { readonly: true });
        const row = check
          .prepare(
            "SELECT text FROM Message WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { text: string };
        check.close();
        return row.text;
      })
      .toContain("This is a partial response");
    await kill();
    await start();
    await page.reload();
    await expect(page.locator(".startup-intro")).toHaveCount(0);
    const restored = await (
      await page.request.get("http://127.0.0.1:3102/api/workspace")
    ).json();
    expect(restored.autopilot).toBe(false);
    expect(restored.orchestrator.id).toBe(savedState.orchestrator.id);
    expect(
      restored.proposals.find((p: { id: string }) => p.id === pendingId),
    ).toMatchObject({ status: "pending", approvedBy: false });
    expect(
      restored.budgets.find(
        (b: { provider: string }) => b.provider === "anthropic",
      ),
    ).toMatchObject({ limit: 0.05, reserved: 0 });
    expect(
      restored.budgets.find(
        (b: { provider: string }) => b.provider === "anthropic",
      ).spent,
    ).toBeGreaterThan(0.03);
    expect(
      (
        await (await page.request.get("http://127.0.0.1:3102/api/audit")).json()
      ).entries.some(
        (e: { action: string }) => e.action === "proposal.created",
      ),
    ).toBe(true);
    await page
      .locator(".sidebar")
      .getByRole("button", { name: /^Conversations/ })
      .click();
    await expect(
      page.getByRole("button", { name: "2-up layout", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Unpin My assistant", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("log")).toContainText("Saved before restart");
    await expect(page.getByRole("log")).toContainText(
      "This is a partial response",
    );
    await expect(page.getByText("Stopped · partial response")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "API keys", exact: true }).click();
    await expect(page.getByText("•••• •••• •••• 1234")).toBeVisible();
  } finally {
    await kill();
  }
});
