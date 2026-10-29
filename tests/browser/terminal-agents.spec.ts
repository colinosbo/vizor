import { test, expect } from "@playwright/test";
test("desktop terminal agents need no API key and keep independent sessions across layout changes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const sessions = new Map<string, any>(),
      listeners = new Set<(event: any) => void>();
    const stopped = (agentId: string) => ({
      agentId,
      state: "stopped" as const,
    });
    window.vizorDesktop = {
      getUpdateState: async () => ({
        state: "idle",
        automatic: true,
        currentVersion: "0.9.0",
      }),
      checkForUpdates: async () => ({
        state: "idle",
        automatic: true,
        currentVersion: "0.9.0",
      }),
      setAutomaticUpdates: async () => ({
        state: "idle",
        automatic: true,
        currentVersion: "0.9.0",
      }),
      restartToUpdate: async () => ({ ok: false }),
      onUpdateState: () => () => {},
      terminals: {
        tools: async () => [
          { engine: "codex", installed: true },
          { engine: "claude-code", installed: true },
        ],
        install: async () => ({ installed: true }),
        setup: async (engine) => stopped(`setup-${engine}`),
        chooseFolder: async () => "C:\\Terminal fixture",
        start: async (agentId) => {
          const s = {
            agentId,
            token: agentId,
            state: "running" as const,
            data: `Session for ${agentId}\r\n`,
          };
          sessions.set(agentId, s);
          listeners.forEach((fn) => fn({ ...s, type: "state" }));
          return s;
        },
        snapshot: async (agentId) => sessions.get(agentId) || stopped(agentId),
        input: async (agentId, token, data) => {
          if (agentId !== token) throw Error("Wrong session");
          listeners.forEach((fn) =>
            fn({ agentId, token, state: "running", type: "data", data }),
          );
        },
        resize: async () => {},
        interrupt: async () => {},
        stop: async (agentId) => {
          sessions.set(agentId, stopped(agentId));
          listeners.forEach((fn) => fn({ ...stopped(agentId), type: "state" }));
        },
        onEvent: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
      },
    };
  });
  await page.goto("/");
  for (const [name, engine] of [
    ["Terminal Claude", "claude-code"],
    ["Terminal Codex", "codex"],
  ]) {
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    const editor = page.getByRole("dialog", { name: "New agent" });
    await editor.getByLabel("Agent name").fill(name);
    await editor.getByLabel("Engine", { exact: true }).selectOption(engine);
    await editor.getByRole("button", { name: "Browse", exact: true }).click();
    await editor
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "New agent" })).toHaveCount(
      0,
    );
  }
  const cards = page.locator(".terminal-panel");
  await expect(cards).toHaveCount(2);
  await expect
    .poll(() =>
      cards
        .first()
        .locator(".xterm-rows")
        .evaluate((el) => getComputedStyle(el).fontFamily),
    )
    .toContain("Consolas");
  for (const card of await cards.all())
    await card.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(cards.first()).toContainText("Running");
  await expect(cards.last()).toContainText("Running");
  await cards.first().locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("only-first");
  await expect(
    cards.first().locator(".xterm-accessibility-tree"),
  ).toContainText("only-first");
  await expect(
    cards.last().locator(".xterm-accessibility-tree"),
  ).not.toContainText("only-first");
  await page.evaluate(() => {
    (window as any).__terminalClipboardWrites = [];
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) =>
        (window as any).__terminalClipboardWrites.push(text),
    });
  });
  await cards
    .first()
    .locator(".xterm-helper-textarea")
    .evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "pasted-to-first");
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await expect(
    cards.first().locator(".xterm-accessibility-tree"),
  ).toContainText("pasted-to-first");
  await expect(
    cards.last().locator(".xterm-accessibility-tree"),
  ).not.toContainText("pasted-to-first");
  await page.evaluate(async () => {
    const agents = (await (await fetch("/api/workspace")).json()).agents;
    const id = agents.find((a: any) => a.name === "Terminal Claude").id;
    await window.vizorDesktop!.terminals!.input(
      id,
      id,
      "\x1b]52;c;c2VjcmV0\x07\x1b]8;;https://terminal-test.invalid\x07escape-link\x1b]8;;\x07\x1b]1337;File=name=fixture:abc\x07",
    );
  });
  await expect(
    cards.first().locator(".xterm-accessibility-tree"),
  ).toContainText("escape-link");
  expect(
    await page.evaluate(() => (window as any).__terminalClipboardWrites),
  ).toEqual([]);
  await expect(
    page.locator('a[href="https://terminal-test.invalid"]'),
  ).toHaveCount(0);
  await cards
    .first()
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await expect(cards.first()).toContainText("Stopped");
  await expect(cards.last()).toContainText("Running");
  await expect(cards.last()).toContainText(
    "API spending caps do not cover this terminal",
  );
  await cards
    .first()
    .getByRole("button", { name: "Move Terminal Claude panel" })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Layout saved" }),
  ).toBeVisible();
});
