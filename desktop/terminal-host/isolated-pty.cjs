const { spawn, spawnSync } = require("node:child_process");
const { join } = require("node:path");
const workers = new Set();
function spawnTerminal(file, args, options) {
  const child = spawn(process.execPath, [join(__dirname, "pty-worker.cjs")], {
    env: options.env,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const dataListeners = [],
    exitListeners = [];
  let settled = false;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const send = (message) => {
    if (child.connected) child.send(message, () => {});
  };
  const terminal = {
    pid: child.pid,
    onData(callback) {
      dataListeners.push(callback);
    },
    onExit(callback) {
      exitListeners.push(callback);
    },
    write(data) {
      send({ type: "input", data });
    },
    resize(cols, rows) {
      send({ type: "resize", cols, rows });
    },
    async kill() {
      if (child.exitCode !== null) return;
      send({ type: "close" });
      const timer = setTimeout(() => {
        if (child.exitCode === null)
          spawnSync(
            join(
              process.env.SystemRoot || "C:/Windows",
              "System32/taskkill.exe",
            ),
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
      }, 6000);
      await exited;
      clearTimeout(timer);
    },
  };
  workers.add(terminal);
  function finish(exitCode) {
    if (settled) return;
    settled = true;
    workers.delete(terminal);
    exitListeners.forEach((fn) => fn({ exitCode }));
  }
  child.on("message", (message) => {
    if (message.type === "data")
      dataListeners.forEach((fn) => fn(message.data));
    else if (message.type === "exit") finish(message.exitCode);
    else if (message.type === "error") finish(1);
  });
  child.once("error", () => finish(1));
  child.once("exit", (code) => finish(code ?? 1));
  send({ type: "start", file, args, options });
  return terminal;
}
module.exports = {
  spawn: spawnTerminal,
  dispose: async () => {
    await Promise.all([...workers].map((worker) => worker.kill()));
  },
};
