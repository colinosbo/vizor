const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
class DesktopTerminals {
  constructor({ resources, home, origin, emit }) {
    Object.assign(this, { resources, home, origin, emit });
    this.pending = new Map();
    this.states = new Map();
    this.helper = null;
  }
  count() {
    return (
      [...this.states.values()].filter((s) => s.state === "running").length +
      this.pending.size
    );
  }
  async ready() {
    if (this.initializing) return this.initializing;
    this.initializing = this.launch();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }
  async launch() {
    if (this.helper) return;
    const response = await fetch(`${this.origin}/api/workspace`);
    const workspace = await response.json();
    if (!response.ok || !workspace.selfHost)
      throw Error(
        "Terminal agents are only available in your local owner workspace.",
      );
    const env = {
      ...process.env,
      VIZOR_TOOLS_HOME: this.home,
      VIZOR_TERMINAL_ORIGIN: this.origin,
    };
    for (const key of [
      "MASTER_KEY",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "VIZOR_UPDATE_SIGNING_KEY",
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
    ])
      delete env[key];
    const helper = spawn(
      join(this.resources, "runtime/node.exe"),
      [join(this.resources, "terminal-host/host.cjs")],
      { env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    this.helper = helper;
    helper.on("message", (message) => {
      if (message?.event) {
        if (message.event.agentId)
          this.states.set(message.event.agentId, message.event);
        this.emit(message.event);
      }
      const request = this.pending.get(message?.id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        message.error
          ? request.reject(Error(message.error))
          : request.resolve(message.result);
      }
    });
    const exited = () => {
      if (this.helper !== helper) return;
      this.helper = null;
      for (const s of this.states.values()) {
        s.state = "stopped";
        this.emit({ ...s, type: "state" });
      }
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          Error("The terminal helper stopped. Resume the agent to continue."),
        );
      }
      this.pending.clear();
    };
    helper.once("error", exited);
    helper.once("exit", exited);
  }
  async request(action, args = {}) {
    if (
      ![
        "tools",
        "install",
        "setup",
        "start",
        "snapshot",
        "list",
        "input",
        "resize",
        "interrupt",
        "stop",
      ].includes(action)
    )
      throw Error("Unknown terminal request");
    await this.ready();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            Error(
              "Terminal request timed out. Check the panel before retrying.",
            ),
          );
        },
        action === "install" ? 360000 : 60000,
      );
      this.pending.set(id, { timer, resolve, reject });
      this.helper.send({ id, action, args }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(Error("The terminal helper is unavailable."));
        }
      });
    });
  }
  async close() {
    const helper = this.helper;
    if (!helper) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (helper.exitCode === null)
          spawnSync(
            join(
              process.env.SystemRoot || "C:/Windows",
              "System32/taskkill.exe",
            ),
            ["/pid", String(helper.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
        resolve();
      }, 8000);
      helper.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      helper.disconnect();
    });
  }
}
module.exports = { DesktopTerminals };
