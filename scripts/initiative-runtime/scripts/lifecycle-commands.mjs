import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  activate,
  defaultOps,
  installedVersions,
  readInstall,
  registerProject,
  runtimeRoot,
  runtimeVersion,
  vizorHome,
  waitForRunner,
  withInstallLock,
} from "./installer.mjs";

export const LIFECYCLE_COMMANDS = [
  "version",
  "versions",
  "rollback",
  "connect",
  "start",
  "stop",
  "open",
];

const check = (condition, message) => {
  if (!condition) throw Error(message);
};
const writePrivate = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });

// The install home that owns this runtime, or null for a source checkout.
export function owningHome(root = runtimeRoot()) {
  return basename(dirname(root)) === "versions" ? dirname(dirname(root)) : null;
}

function powershell(script, args) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(runtimeRoot(), "windows", script),
      ...args,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 180000 },
  );
  const output = ((result.stdout || "") + (result.stderr || "")).trim();
  if (result.error || result.status !== 0)
    throw Error(output || script + " failed");
  return output;
}

function parseConnect(args) {
  const out = { workers: [], port: 4388 };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--repo") out.repo = value;
    else if (args[i] === "--manager") out.manager = value;
    else if (args[i] === "--port") out.port = Number(value);
    else if (args[i] === "--worker") out.workers.push(value);
    else if (args[i] === "--help") out.help = true;
    else continue;
    i++;
  }
  return out;
}

const CONNECT_HELP = `Connect this folder to a GitHub repository and worker accounts:

  vizor connect --repo <owner/repo> --manager <your GitHub login> --worker <id>=<Display Name> [--worker ...] [--port 4388]

Example:
  vizor connect --repo acme/widgets --manager octocat --worker builder=Builder --worker reviewer=Reviewer

This writes vizor.config.json and a private .vizor folder (queue, credentials template).
Assignment comments must use the heading "### Task for <Display Name>" from a --manager login.`;

function connect(args) {
  const options = parseConnect(args);
  if (options.help || !options.repo) return console.log(CONNECT_HELP);
  check(
    !existsSync("vizor.config.json"),
    "This folder is already connected (vizor.config.json exists). Edit it, or run vizor doctor.",
  );
  check(/^[\w.-]+\/[\w.-]+$/.test(options.repo), "Use --repo owner/repo.");
  check(
    /^[a-z0-9][a-z0-9-]{0,38}$/i.test(options.manager ?? ""),
    "Use --manager <your GitHub login>.",
  );
  check(options.workers.length, "Add at least one --worker id=Display Name.");
  check(
    Number.isInteger(options.port) &&
      options.port >= 1024 &&
      options.port <= 65534,
    "Use a --port between 1024 and 65534 (the dashboard uses port + 1).",
  );
  const agents = {};
  for (const spec of options.workers) {
    const [id, ...rest] = spec.split("=");
    const name = rest.join("=").trim();
    check(
      /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) && name && !agents[id],
      "Use --worker <lowercase-id>=<Display Name>, once per worker.",
    );
    agents[id] = { name, label: id, trustedManagers: [options.manager] };
  }
  const config = {
    repository: options.repo,
    port: options.port,
    dispatchLabel: "vizor:dispatch",
    agents,
  };
  writeFileSync("vizor.config.json", JSON.stringify(config, null, 2) + "\n");
  mkdirSync(".vizor", { recursive: true, mode: 0o700 });
  const queue = join(".vizor", "queue.json");
  if (!existsSync(queue))
    writeFileSync(
      queue,
      JSON.stringify(
        { paused: false, issues: [], dispatchMode: "local" },
        null,
        2,
      ) + "\n",
    );
  const secrets = join(".vizor", "secrets.json");
  if (!existsSync(secrets))
    writePrivate(secrets, {
      webhookSecret: randomBytes(32).toString("hex"),
      agents: Object.fromEntries(
        Object.keys(agents).map((id) => [id, { fireUrl: "", token: "" }]),
      ),
    });
  // Keep private state out of the project's Git history.
  const ignore = ".gitignore";
  const lines = existsSync(ignore)
    ? readFileSync(ignore, "utf8").split(/\r?\n/)
    : [];
  if (
    !lines.some((line) => line.trim() === ".vizor/" || line.trim() === ".vizor")
  )
    appendFileSync(
      ignore,
      (lines.length && lines.at(-1) !== "" ? "\n" : "") + ".vizor/\n",
    );
  console.log(
    [
      "Connected " +
        options.repo +
        " with " +
        Object.keys(agents).length +
        " worker(s).",
      "",
      "Next:",
      "  1. Paste each worker's routine fireUrl and token into " +
        secrets +
        " (keep it private).",
      "  2. vizor labels        create the dispatch and worker labels in GitHub",
      "  3. vizor doctor        check GitHub access, labels and worker credentials",
      "  4. vizor start         start the background runner (Windows)",
      "  5. vizor open          open the dashboard",
    ].join("\n"),
  );
}

const readHost = () =>
  existsSync(".vizor/runtime-host.json")
    ? JSON.parse(readFileSync(".vizor/runtime-host.json", "utf8"))
    : null;

function dashboardUrl() {
  const config = JSON.parse(readFileSync("vizor.config.json", "utf8"));
  return "http://127.0.0.1:" + (config.port + 1);
}

function start(args) {
  check(
    existsSync("vizor.config.json"),
    "Run vizor start from a connected project folder (vizor connect first).",
  );
  if (process.platform !== "win32") {
    console.log(
      "Supervised background start is Windows-only. In a terminal you keep open, run:\n" +
        "  vizor schedule .vizor/queue.json\n  vizor dashboard .vizor/queue.json",
    );
    return;
  }
  const host = readHost();
  const queue = resolve(host?.queue ?? ".vizor/queue.json");
  const installedRoot = host?.runtime ? resolve(host.runtime) : null;
  const root = runtimeRoot();
  // Windows paths compare case-insensitively (C:\ and c:\ are one folder).
  const sameRuntime =
    installedRoot !== null &&
    (process.platform === "win32"
      ? installedRoot.toLowerCase() === root.toLowerCase()
      : installedRoot === root);
  const urlIndex = args.indexOf("--webhook-url");
  const webhookUrl = urlIndex >= 0 ? args[urlIndex + 1] : host?.webhookUrl;
  check(
    urlIndex < 0 || /^https:\/\//.test(webhookUrl ?? ""),
    "Pass --webhook-url <public HTTPS URL that forwards to the relay>.",
  );
  if (!host || urlIndex >= 0 || args.includes("--reinstall") || !sameRuntime) {
    const mode =
      urlIndex >= 0
        ? "webhook"
        : (JSON.parse(readFileSync(queue, "utf8")).dispatchMode ?? "local");
    const params = [
      "-ProjectPath",
      process.cwd(),
      "-QueuePath",
      queue,
      "-Mode",
      mode,
    ];
    if (host?.prefix) params.push("-TaskPrefix", host.prefix);
    if (mode === "webhook" && webhookUrl)
      params.push("-WebhookUrl", webhookUrl);
    // Stop anything from an older runtime first; the queue lease covers races.
    if (host)
      console.log(powershell("stop.ps1", ["-ProjectPath", process.cwd()]));
    console.log(powershell("install.ps1", params));
  } else {
    console.log(powershell("start.ps1", ["-ProjectPath", process.cwd()]));
  }
  // Started again: upgrades and rollbacks may restart this project.
  rmSync(join(".vizor", "stopped"), { force: true });
  const home = owningHome(root);
  if (home) registerProject(home, process.cwd());
  else
    console.log(
      "Note: running from a source checkout. Install a release package so upgrades and rollback manage this project.",
    );
  const snapshot = waitForRunner(process.cwd(), queue, root, {
    wait: (ms) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    timeoutMs: 60000,
  });
  console.log(
    "Runner is up (pid " + snapshot.pid + "). Dashboard: " + dashboardUrl(),
  );
}

function stop() {
  if (process.platform !== "win32")
    return console.log(
      "Stop the foreground schedule/dashboard processes with Ctrl+C.",
    );
  console.log(
    powershell("stop.ps1", ["-ProjectPath", process.cwd(), "-Disable"]),
  );
}

async function open(args) {
  check(
    existsSync("vizor.config.json"),
    "Run vizor open from a connected project folder.",
  );
  const url = dashboardUrl();
  let up = false;
  try {
    up = (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {}
  if (!up)
    throw Error(
      "The dashboard is not answering at " +
        url +
        ". Run vizor start (Windows) or vizor dashboard .vizor/queue.json.",
    );
  console.log(url);
  if (args.includes("--print")) return;
  // explorer.exe hands an http URL to the default browser with no cmd quoting.
  const program =
    process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  spawnSync(program, [url], { stdio: "ignore", windowsHide: true });
}

function versions() {
  const home = owningHome() ?? vizorHome();
  const install = readInstall(home);
  console.log("Install home: " + home);
  for (const version of installedVersions(home))
    console.log(
      (version === install.current ? "* " : "  ") +
        version +
        (version === install.previous ? "  (rollback target)" : ""),
    );
  if (install.projects.length) {
    console.log("Projects:");
    for (const project of install.projects) console.log("  " + project);
  }
}

function rollback() {
  const home = owningHome() ?? vizorHome();
  const result = withInstallLock(home, () => {
    const install = readInstall(home);
    check(install.previous, "No previous version recorded to roll back to.");
    return activate(home, install.previous, defaultOps());
  });
  console.log("Rolled back " + result.from + " -> " + result.to + ".");
}

export async function runLifecycle(command, args) {
  if (command === "version") return console.log(runtimeVersion());
  if (command === "versions") return versions();
  if (command === "rollback") return rollback();
  if (command === "connect") return connect(args);
  if (command === "start") return start(args);
  if (command === "stop") return stop();
  if (command === "open") return open(args);
}
