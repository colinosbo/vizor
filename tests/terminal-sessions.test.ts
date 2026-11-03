import { it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const {
  Sessions,
  environment,
  projectPath,
} = require("../desktop/terminal-host/sessions.cjs");
function fixture() {
  const terminals: any[] = [];
  const pty = {
    spawn: vi.fn((file, args, options) => {
      const terminal: any = {
        file,
        args,
        options,
        pid: 12345,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: (cb: any) => {
          terminal.data = cb;
        },
        onExit: (cb: any) => {
          terminal.exit = cb;
        },
      };
      terminals.push(terminal);
      return terminal;
    }),
  };
  const notify = vi.fn(),
    persist = vi.fn(async () => {}),
    bootstrap = vi.fn(async () => randomUUID());
  const sessions = new Sessions({
    pty,
    notify,
    persist,
    bootstrap,
    env: environment({
      USERPROFILE: resolve("artifacts/nonexistent-terminal-test"),
    }),
    findTool: () => "official-tool.exe",
    terminate: (terminal: any) => terminal.kill(),
  });
  const agent = (id: string, engine = "claude-code") => ({
    id,
    engine,
    name: id,
    projectPath: resolve("."),
    nativeSessionId: engine === "claude-code" ? randomUUID() : null,
    terminalStarted: false,
  });
  return { sessions, terminals, pty, notify, persist, bootstrap, agent };
}
it("isolates input, resize and stop by agent AND live session token", async () => {
  const f = fixture();
  const a = await f.sessions.start(f.agent("a"));
  const b = await f.sessions.start(f.agent("b"), true);
  f.sessions.input("a", a.token, "task A");
  expect(f.terminals[0].write).toHaveBeenCalledWith("task A");
  expect(f.terminals[1].write).not.toHaveBeenCalled();
  expect(() => f.sessions.input("b", a.token, "wrong")).toThrow();
  expect(() => f.sessions.stop("b", a.token)).toThrow();
  f.sessions.resize("b", b.token, 80, 30);
  expect(f.terminals[1].resize).toHaveBeenCalledWith(80, 30);
  expect(() => f.sessions.resize("b", b.token, 100000, -1)).toThrow();
  f.sessions.stop("a", a.token);
  expect(f.terminals[0].kill).toHaveBeenCalled();
  expect(f.terminals[1].kill).not.toHaveBeenCalled();
});
it("requires explicit confirmation for a second writer in the same canonical project", async () => {
  const f = fixture();
  await f.sessions.start(f.agent("a"));
  expect(await f.sessions.start(f.agent("b"))).toEqual({ conflict: true });
  expect(f.pty.spawn).toHaveBeenCalledTimes(1);
});
it("deduplicates starts and rejects stale input after a process is resumed", async () => {
  const f = fixture();
  const agent = f.agent("a");
  const a = await f.sessions.start(agent);
  expect((await f.sessions.start(agent)).token).toBe(a.token);
  f.sessions.stop("a", a.token);
  const b = await f.sessions.start(agent);
  expect(b.token).not.toBe(a.token);
  expect(() => f.sessions.input("a", a.token, "stale")).toThrow();
});
it("waits for the CLI prompt and submits a multiline assignment as one paste", async () => {
  const f = fixture();
  const session = await f.sessions.start(f.agent("a"));
  expect(session.inputReady).toBe(false);
  f.terminals[0].data("Claude Code startup\r\n❯ ");
  await vi.waitFor(() =>
    expect(f.sessions.snapshot("a").inputReady).toBe(true),
  );
  await f.sessions.sendTask(
    "a",
    session.token,
    "Inspect source\nReport findings",
  );
  expect(f.terminals[0].write).toHaveBeenNthCalledWith(
    1,
    "\x1b[200~Inspect source\nReport findings\x1b[201~",
  );
  expect(f.terminals[0].write).toHaveBeenNthCalledWith(2, "\r");
  expect(f.sessions.snapshot("a").inputReady).toBe(false);
});
it("keeps the native Claude permission prompts and resumes Codex by its exact native ID", async () => {
  const f = fixture();
  await f.sessions.start(f.agent("a"));
  expect(f.terminals[0].args).toContain("acceptEdits");
  expect(f.terminals[0].args).toContain('{"forceLoginMethod":"claudeai"}');
  expect(f.terminals[0].args).not.toContain("--dangerously-skip-permissions");
  const a = f.agent("b", "codex");
  a.nativeSessionId = randomUUID();
  await f.sessions.start(a, true);
  expect(f.terminals[1].args.slice(0, 2)).toEqual([
    "resume",
    a.nativeSessionId,
  ]);
  expect(f.bootstrap).not.toHaveBeenCalled();
});
it("prepares and persists a new Codex thread without starting an inference turn", async () => {
  const f = fixture();
  const result = await f.sessions.start(f.agent("a", "codex"));
  expect(f.bootstrap).toHaveBeenCalledTimes(1);
  expect(f.persist).toHaveBeenCalledWith(
    "a",
    result.nativeSessionId,
    "started",
  );
});
it("tracks exit state accurately, bounds replay and stops only owned processes on disconnect", async () => {
  const f = fixture();
  const a = await f.sessions.start(f.agent("a"));
  f.terminals[0].data("x".repeat(5 * 1024 * 1024));
  expect(f.sessions.snapshot("a").data.length).toBe(4 * 1024 * 1024);
  f.terminals[0].exit({ exitCode: 2 });
  expect(f.sessions.snapshot("a").state).toBe("stopped");
  expect(() => f.sessions.interrupt("a", a.token)).toThrow();
  await f.sessions.start(f.agent("b"));
  f.sessions.dispose();
  expect(f.terminals[1].kill).toHaveBeenCalled();
});
it("does not launch paused/archived agents, arbitrary paths, oversized input or unknown engines", async () => {
  const f = fixture();
  await expect(
    f.sessions.start({ ...f.agent("a"), archived: true }),
  ).rejects.toThrow();
  expect(() => projectPath("relative-folder")).toThrow();
  expect(() => projectPath("\0")).toThrow();
  const a = await f.sessions.start(f.agent("a"));
  expect(() => f.sessions.input("a", a.token, "x".repeat(65537))).toThrow();
  const tools = require("../desktop/terminal-host/tools.cjs");
  expect(() => tools.findTool("toString", resolve("."))).toThrow();
});
it("does not inherit Vizor encryption, API, release or GitHub keys into tools", () => {
  const env = environment({
    MASTER_KEY: "private",
    DATABASE_URL: "private",
    ANTHROPIC_API_KEY: "private",
    OPENAI_API_KEY: "private",
    GITHUB_TOKEN: "private",
    VIZOR_UPDATE_SIGNING_KEY: "private",
    PATH: "safe",
    USERPROFILE: "user",
  });
  expect(JSON.stringify(env)).not.toContain("private");
  expect(env.PATH).toBe("safe");
});
it("rejects tampered native downloads before creating any executable or install directory", () => {
  const home = mkdtempSync(resolve(tmpdir(), "vizor-tool-check-"));
  try {
    const { installBytes } = require("../desktop/terminal-host/tools.cjs");
    for (const engine of ["claude-code", "codex"])
      expect(() =>
        installBytes(engine, home, Buffer.from("invalid release")),
      ).toThrow("checksum did not match");
    expect(existsSync(resolve(home, "tools"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it("recognizes a cursor-positioned fragmented CLI prompt without mistaking setup previews for input", async () => {
  const f = fixture();
  await f.sessions.start(f.agent("screen"));
  const terminal = f.terminals[0];
  terminal.data("Syntax theme: Monokai Extended (ctrl+t to disable)");
  await new Promise((done) => setTimeout(done, 20));
  expect(f.sessions.snapshot("screen").inputReady).toBe(false);
  terminal.data("\x1b[2J\x1b[12;");
  terminal.data('1H› Try "fix lint errors"\x1b[12;3H');
  await vi.waitFor(() =>
    expect(f.sessions.snapshot("screen").inputReady).toBe(true),
  );
  terminal.data("\x1b[2J\x1b[1;1HDo you trust this folder?");
  await vi.waitFor(() =>
    expect(f.sessions.snapshot("screen").inputReady).toBe(false),
  );
  f.sessions.dispose();
});
it("submits a multiline paste even when its echo moves the cursor away from the prompt", async () => {
  const f = fixture();
  const session = await f.sessions.start(f.agent("paste"));
  const terminal = f.terminals[0];
  terminal.data("❯ ");
  await vi.waitFor(() =>
    expect(f.sessions.snapshot("paste").inputReady).toBe(true),
  );
  terminal.write.mockImplementation((text: string) => {
    if (text.startsWith("\x1b[200~"))
      terminal.data(
        "\x1b[2J\x1b[1;1H❯ first line\r\nsecond line\r\nthird line",
      );
  });
  await f.sessions.sendTask(
    "paste",
    session.token,
    "first line\nsecond line\nthird line",
  );
  expect(terminal.write).toHaveBeenLastCalledWith("\r");
  expect(terminal.write).not.toHaveBeenCalledWith("\x03");
  f.sessions.dispose();
});
it("never treats the native permission-choice cursor as a task entry prompt", async () => {
  const f = fixture();
  await f.sessions.start(f.agent("permissions"));
  f.terminals[0].data("Do you want to run this command?\r\n❯ 1. Yes");
  await new Promise((done) => setTimeout(done, 30));
  expect(f.sessions.snapshot("permissions").inputReady).toBe(false);
  expect(f.terminals[0].write).not.toHaveBeenCalled();
  f.sessions.dispose();
});
