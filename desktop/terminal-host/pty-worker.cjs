// One native PTY per owned Node process. Exiting closes all ConPTY handles.
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
let terminal,
  ended = false;
const send = (value) => {
  if (process.connected) process.send(value);
};
function close() {
  if (ended) return;
  ended = true;
  if (terminal)
    spawnSync(
      join(process.env.SystemRoot || "C:/Windows", "System32/taskkill.exe"),
      ["/pid", String(terminal.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 5000 },
    );
  process.exit(0);
}
process.on("message", (message) => {
  try {
    if (message.type === "start" && !terminal) {
      terminal = require("node-pty").spawn(
        message.file,
        message.args,
        message.options,
      );
      send({ type: "ready", pid: terminal.pid });
      terminal.onData((data) => {
        if (process.connected) {
          const writable = process.send({ type: "data", data }, () => {
            try {
              terminal.resume();
            } catch {}
          });
          if (!writable) terminal.pause();
        }
      });
      terminal.onExit((event) => {
        ended = true;
        if (process.connected)
          process.send({ type: "exit", ...event }, () => process.exit(0));
        else process.exit(0);
      });
    } else if (message.type === "input") terminal?.write(message.data);
    else if (message.type === "resize")
      terminal?.resize(message.cols, message.rows);
    else if (message.type === "close") close();
  } catch {
    send({ type: "error" });
    close();
  }
});
process.on("disconnect", close);
