import { test, expect } from "@playwright/test";

for (const automatic of [false, true]) {
  test(
    automatic
      ? "approved queue delivers terminal work without a per-task click"
      : "approving a terminal task delivers it automatically and routes input once",
    async ({ page }) => {
      const state = await (await page.request.get("/api/workspace")).json();
      const created = await page.request.post("/api/agents", {
        headers: { origin: "http://127.0.0.1:3105" },
        data: {
          name: "Dispatch fixture",
          engine: "claude-code",
          projectPath: "C:\\Dispatch fixture",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          systemPrompt: "Fixture",
          temperature: 0.4,
          maxTokens: 512,
          color: "amber",
          icon: "code",
        },
      });
      expect(created.ok()).toBe(true);
      const agentId = (await created.json()).id;
      const fresh = await (await page.request.get("/api/workspace")).json();
      let approved = automatic,
        delivered = false;
      const proposal = {
        id: "dispatch-ui-fixture",
        action: "dispatch_terminal",
        agentId,
        status: "pending",
        version: 0,
        createdAt: new Date().toISOString(),
        resultRunId: null,
        error: null,
        approvedBy: false,
        payload: {
          action: "dispatch_terminal",
          agentId,
          text: "Read-only fixture task",
        },
      };
      await page.route("**/api/workspace", (route) =>
        route.fulfill({
          json: {
            ...fresh,
            queueEnabled: automatic,
            proposals: [
              {
                ...proposal,
                status: approved ? "approved" : "pending",
                approvedBy: approved,
              },
            ],
            pendingProposalCount: approved ? 0 : 1,
            terminalDispatches: approved
              ? [
                  {
                    id: "dispatch-fixture",
                    proposalId: proposal.id,
                    agentId,
                    text: proposal.payload.text,
                    status: delivered ? "delivered" : "ready",
                    error: null,
                  },
                ]
              : [],
          },
        }),
      );
      await page.route("**/api/proposals/*/approve", (route) => {
        approved = true;
        return route.fulfill({ json: { ok: true } });
      });
      await page.route("**/api/terminal-dispatches/*/claim", (route) =>
        route.fulfill({ json: { agentId, text: proposal.payload.text } }),
      );
      await page.route("**/api/terminal-dispatches/*/complete", (route) => {
        delivered = true;
        return route.fulfill({ json: { ok: true } });
      });
      await page.addInitScript(() => {
        const update = async () => ({
          state: "idle" as const,
          automatic: true,
          currentVersion: "0.10.4",
        });
        (window as any).__sent = [];
        window.vizorDesktop = {
          getUpdateState: update,
          checkForUpdates: update,
          setAutomaticUpdates: update,
          restartToUpdate: async () => ({ ok: false }),
          onUpdateState: () => () => {},
          terminals: {
            snapshot: async (id: string) => ({
              agentId: id,
              state: "running",
              token: id,
            }),
            input: async (id: string, token: string, text: string) => {
              (window as any).__sent.push({ id, token, text });
            },
            onEvent: () => () => {},
            sendTask: async (id: string, token: string, text: string) => {
              if (id !== token) throw Error("Wrong session");
              (window as any).__sent.push({ id, token, text: `${text}\r` });
              return { ok: true as const };
            },
          } as any,
        };
      });
      await page.goto("/");
      await expect(page.locator(".startup-intro")).toHaveCount(0);
      await page
        .locator(".sidebar")
        .getByRole("button", { name: /^Approvals/ })
        .click();
      if (!automatic)
        await page
          .getByRole("button", { name: "Approve", exact: true })
          .click();
      await expect(
        page.getByText(
          automatic
            ? "Queued task sent to the worker."
            : "Task sent to the selected terminal agent.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Retry delivery", exact: true }),
      ).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__sent)).toEqual([
        { id: agentId, token: agentId, text: "Read-only fixture task\r" },
      ]);
      await page.request.post(`/api/agents/${agentId}/archive`, {
        headers: { origin: "http://127.0.0.1:3105" },
      });
    },
  );
}
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
            inputReady: true,
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
        sendTask: async (agentId, token, text) => {
          if (agentId !== token) throw Error("Wrong session");
          listeners.forEach((fn) =>
            fn({
              agentId,
              token,
              state: "running",
              type: "data",
              data: `${text}\r\n`,
            }),
          );
          return { ok: true as const };
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
  await expect(page.locator(".startup-intro")).toHaveCount(0);
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
  await expect(
    page.getByRole("button", { name: "Show all active agents" }),
  ).toHaveAttribute("aria-pressed", "true");
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
  await expect(cards.first()).toContainText("Terminal ready");
  await expect(cards.last()).toContainText("Terminal ready");
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
  await expect(cards.last()).toContainText("Terminal ready");
  await expect(cards.last().locator(".terminal-title small")).toHaveAttribute(
    "title",
    /managed inside Codex/,
  );
  await cards
    .last()
    .getByRole("button", { name: "Collapse Terminal Codex" })
    .click();
  await page.evaluate(async () => {
    const agents = (await (await fetch("/api/workspace")).json()).agents;
    const id = agents.find((a: any) => a.name === "Terminal Codex").id;
    await window.vizorDesktop!.terminals!.stop(id, id);
  });
  await expect(cards.last()).toContainText("Stopped");
  await cards
    .last()
    .getByRole("button", { name: "Expand Terminal Codex" })
    .click();
  await cards
    .first()
    .getByRole("button", { name: "Move Terminal Claude panel" })
    .focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("status").filter({ hasText: "Layout saved" }),
  ).toBeVisible();
});
test("shows every worker in a five-agent plan, hides unrelated agents, and saves dragging", async ({
  page,
}) => {
  const members: string[] = [];
  for (let index = 0; index < 6; index++) {
    const response = await page.request.post("/api/agents", {
      headers: { origin: "http://127.0.0.1:3105" },
      data: {
        name: index < 5 ? `Plan worker ${index + 1}` : "Unrelated worker",
        engine: "claude-code",
        projectPath: "C:\\Plan fixture",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt: "Fixture only",
        temperature: 0.4,
        maxTokens: 512,
        color: "amber",
        icon: "code",
      },
    });
    expect(response.ok()).toBe(true);
    members.push((await response.json()).id);
  }
  await page.request.patch("/api/layout", {
    headers: { origin: "http://127.0.0.1:3105" },
    data: {
      mode: "team",
      scope: "plan",
      activeId: members[0],
      order: members,
      pinned: [],
      collapsed: [],
      layouts: {},
    },
  });
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: { ...data, hasPlanChat: true, currentTeamIds: members.slice(0, 5) },
    });
  });
  await page.addInitScript(() => {
    const update = async () => ({
      state: "idle" as const,
      automatic: true,
      currentVersion: "0.10.14",
    });
    window.vizorDesktop = {
      getUpdateState: update,
      checkForUpdates: update,
      setAutomaticUpdates: update,
      restartToUpdate: async () => ({ ok: false }),
      onUpdateState: () => () => {},
      terminals: {
        snapshot: async (id: string) => ({ agentId: id, state: "stopped" }),
        onEvent: () => () => {},
      } as any,
    };
  });
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Agent board/ })
    .click();
  await expect(page.locator(".terminal-panel")).toHaveCount(5);
  await page.getByLabel("Chat text size").selectOption("large");
  await expect
    .poll(() =>
      page
        .locator(".terminal-panel .xterm-rows")
        .first()
        .evaluate((element) => getComputedStyle(element).fontSize),
    )
    .toBe("17px");
  await expect(page.locator(".agent-list .agent-nav")).toHaveCount(5);
  await expect(
    page.locator(".terminal-panel").filter({ hasText: "Unrelated worker" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Next agents", exact: true }),
  ).toHaveCount(0);
  const grip = page.getByRole("button", {
    name: "Move Plan worker 1 panel",
    exact: true,
  });
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 110, { steps: 20 });
  await page.mouse.up();
  const saved = async () =>
    (await (await page.request.get("/api/workspace")).json()).layout.layouts
      .team;
  await expect.poll(async () => (await saved())?.length ?? 0).toBe(5);
  const position = (await saved()).find((item: any) => item.i === members[0]);
  expect(position.x > 0 || position.y > 0).toBe(true);
  await page.reload();
  await page
    .locator(".sidebar")
    .getByRole("button", { name: /^Agent board/ })
    .click();
  await expect(page.locator(".terminal-panel")).toHaveCount(5);
  expect((await saved()).find((item: any) => item.i === members[0])).toEqual(
    position,
  );
});
for (const stopped of [false, true]) {
  test(`Orchestrator clarification ${stopped ? "waits for a stopped worker" : "automatically returns to its running worker once"}`, async ({
    page,
  }) => {
    const created = await page.request.post("/api/agents", {
      headers: { origin: "http://127.0.0.1:3105" },
      data: {
        name: "Question worker",
        engine: "claude-code",
        projectPath: "C:\\Question fixture",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        systemPrompt: "Fixture",
        temperature: 0.4,
        maxTokens: 512,
        color: "blue",
        icon: "code",
      },
    });
    const agentId = (await created.json()).id;
    const fresh = await (await page.request.get("/api/workspace")).json();
    let complete = false,
      released = false;
    await page.route("**/api/workspace", (route) =>
      route.fulfill({
        json: {
          ...fresh,
          proposals: [],
          currentTeamIds: [agentId],
          terminalDispatches: [
            {
              id: "auto-reply",
              proposalId: "auto-proposal",
              agentId,
              status: complete ? "delivered" : "ready",
              autoDeliver: true,
              questions: "[]",
              text: "Use 180 seconds, as the approved plan specifies.",
              error: null,
            },
          ],
        },
      }),
    );
    await page.route("**/api/terminal-dispatches/*/claim", (route) =>
      route.fulfill({
        json: {
          agentId,
          text: "Use 180 seconds, as the approved plan specifies.",
        },
      }),
    );
    await page.route("**/api/terminal-dispatches/*/complete", (route) => {
      complete = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/terminal-dispatches/*/release", (route) => {
      released = true;
      return route.fulfill({ json: { ok: true } });
    });
    await page.addInitScript(
      ({ stopped }) => {
        (window as any).__autoReplies = [];
        const update = async () => ({
          state: "idle" as const,
          automatic: true,
          currentVersion: "0.10.15",
        });
        window.vizorDesktop = {
          getUpdateState: update,
          checkForUpdates: update,
          setAutomaticUpdates: update,
          restartToUpdate: async () => ({ ok: false }),
          onUpdateState: () => () => {},
          terminals: {
            snapshot: async (id: string) => ({
              agentId: id,
              token: id,
              state: stopped ? "stopped" : "running",
              inputReady: true,
            }),
            start: async () => {
              throw Error("Automatic replies must not restart stopped workers");
            },
            sendTask: async (id: string, token: string, text: string) => {
              (window as any).__autoReplies.push({ id, text });
              return { ok: true };
            },
            onEvent: () => () => {},
            resize: async () => {},
          } as any,
        };
      },
      { stopped },
    );
    await page.goto("/");
    if (stopped) {
      await expect.poll(() => released).toBe(true);
      expect(complete).toBe(false);
      expect(await page.evaluate(() => (window as any).__autoReplies)).toEqual(
        [],
      );
    } else {
      await expect.poll(() => complete).toBe(true);
      expect(await page.evaluate(() => (window as any).__autoReplies)).toEqual([
        {
          id: agentId,
          text: "Use 180 seconds, as the approved plan specifies.",
        },
      ]);
      await page.reload();
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as any).__autoReplies)).toEqual(
        [],
      );
    }
  });
}
