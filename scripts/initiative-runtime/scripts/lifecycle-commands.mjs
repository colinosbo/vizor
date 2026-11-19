import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { cpSync, readdirSync } from "node:fs";
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
import { windowsPowerShellEnv } from "./runtime-control.mjs";

export const LIFECYCLE_COMMANDS = [
  "version",
  "versions",
  "rollback",
  "connect",
  "start",
  "stop",
  "open",
  "autonomy",
  "skills",
  "investigator",
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
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 180000,
      env: windowsPowerShellEnv(),
    },
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
      "  3. vizor investigator  turn on blocker investigation (needs the Claude CLI signed in)",
      "  4. vizor doctor        check GitHub access, labels, worker credentials and the investigator",
      "  5. vizor start         start the background runner (Windows)",
      "  6. vizor open          open the dashboard",
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

// How much the agents do on their own. Every level keeps the hard rails:
// assignment scope, no secrets, workers never orchestrate, and code is
// accepted only when the plan's checks pass on the merged commit.
export const AUTONOMY = {
  supervised: {
    label: "Supervised",
    summary:
      "You approve everything: workers open draft PRs, you accept every review and merge every PR yourself.",
    github:
      "No GitHub settings are changed. Merge PRs yourself after review; workers open draft PRs, mark one ready when you approve it.",
  },
  standard: {
    label: "Standard",
    summary:
      "Reviews with immutable evidence are accepted automatically; you (or GitHub auto-merge on required checks) merge PRs; blockers wait for you.",
    github:
      "Vizor turns on Allow auto-merge and adds a ruleset that requires the plan's checks on the default branch, so a PR merges only after they pass.",
  },
  brazy: {
    label: "braZy",
    summary:
      "Full release inside the rails: reviews auto-accepted, workers merge their own PR once every named check passes, failed verifications get automatic repair, and workers only stop for credentials, spending or outside commitments.",
    github:
      "Vizor turns on Allow auto-merge and adds a ruleset that requires the plan's checks on the default branch, so no PR (including a worker's) merges before they pass.",
  },
};

function autonomy(args) {
  check(
    existsSync("vizor.config.json"),
    "Run vizor autonomy from a connected project folder.",
  );
  const queueFile = join(".vizor", "queue.json");
  const config = JSON.parse(readFileSync("vizor.config.json", "utf8"));
  const queue = JSON.parse(readFileSync(queueFile, "utf8"));
  const level = args[0]?.toLowerCase();
  if (!level) {
    const current = config.autonomy ?? "standard";
    console.log(
      "Autonomy: " +
        AUTONOMY[current].label +
        " - " +
        AUTONOMY[current].summary +
        "\nQueue: autoAcceptReviews=" +
        Boolean(queue.autoAcceptReviews) +
        ", autoRepair=" +
        (queue.autoRepair ? queue.autoRepair.agent : "off") +
        ", blockerOrchestrator=" +
        Boolean(queue.blockerOrchestrator) +
        "\nChange it with: vizor autonomy supervised | standard | brazy",
    );
    return;
  }
  check(
    Object.hasOwn(AUTONOMY, level),
    "Use vizor autonomy supervised | standard | brazy.",
  );
  const repairIndex = args.indexOf("--repair-agent");
  const repairAgent = repairIndex >= 0 ? args[repairIndex + 1] : undefined;
  const repairChecks = args
    .map((arg, i) => (arg === "--repair-check" ? args[i + 1] : null))
    .filter(Boolean);
  if (args.includes("--repair-agent"))
    check(
      Object.hasOwn(config.agents, repairAgent ?? "") && repairChecks.length,
      "Use --repair-agent <worker id> with at least one --repair-check <check name>.",
    );
  const notes = [];
  queue.autoAcceptReviews = level !== "supervised";
  if (level === "brazy") {
    if (repairAgent)
      queue.autoRepair = { agent: repairAgent, checks: repairChecks };
    if (!queue.autoRepair)
      notes.push(
        "Automatic repair is off until you name a builder: vizor autonomy brazy --repair-agent <id> --repair-check <check>.",
      );
  } else {
    delete queue.autoRepair;
  }
  // Blocker investigation is core at every level; it never grants access.
  if (existsSync(join(".vizor", "orchestrator-host.json")))
    queue.blockerOrchestrator = true;
  else
    notes.push(
      "Blocker investigation is not set up yet: run vizor investigator.",
    );
  config.autonomy = level;
  for (const [file, data] of [
    [queueFile, queue],
    ["vizor.config.json", config],
  ]) {
    const temp = file + ".autonomy.tmp";
    writeFileSync(temp, JSON.stringify(data, null, 2) + "\n");
    renameSync(temp, file);
  }
  console.log(
    [
      "Autonomy set to " + AUTONOMY[level].label + ".",
      AUTONOMY[level].summary,
      "In GitHub: " + AUTONOMY[level].github,
      ...notes,
      "The runner applies the queue settings on its next round. Commit vizor.config.json so workers see the level.",
      "Applying the GitHub merge rails (run vizor rails again after a plan with new checks is merged):",
    ].join("\n"),
  );
}

// Copy the bundled skills: worker skills into this project's .claude/skills
// (commit them so cloud worker routines load them), operator skills into the
// user's Claude Code skills folder. Existing skills are never overwritten
// unless --force is given.
function skills(args) {
  const source = join(runtimeRoot(), "skills");
  check(existsSync(source), "This Vizor version has no bundled skills.");
  const targets = [];
  if (!args.includes("--operator-only")) {
    check(
      existsSync("vizor.config.json"),
      "Run vizor skills from a connected project folder (or use --operator-only).",
    );
    targets.push([join(source, "worker"), join(".claude", "skills")]);
  }
  if (!args.includes("--workers-only"))
    targets.push([
      join(source, "operator"),
      join(
        process.env.VIZOR_SKILLS_HOME || join(homedir(), ".claude"),
        "skills",
      ),
    ]);
  for (const [from, to] of targets) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      const dest = join(to, name);
      if (existsSync(dest) && !args.includes("--force")) {
        console.log("Kept existing " + dest + " (use --force to replace).");
        continue;
      }
      cpSync(join(from, name), dest, { recursive: true, force: true });
      console.log("Installed " + dest);
    }
  }
  if (!args.includes("--operator-only"))
    console.log(
      "Commit .claude/skills and vizor.config.json so the worker routines load them.",
    );
}

// Find the Claude Code CLI: --claude <path>, then PATH, then the default
// per-user install location.
function findClaude(args) {
  const flag = args.indexOf("--claude");
  if (flag >= 0) return resolve(args[flag + 1] ?? "");
  const lookup = spawnSync(
    process.platform === "win32" ? "where.exe" : "which",
    ["claude"],
    { encoding: "utf8", windowsHide: true },
  );
  const found =
    lookup.status === 0 ? lookup.stdout.split(/\r?\n/)[0].trim() : "";
  if (found && (process.platform !== "win32" || /\.exe$/i.test(found)))
    return found;
  const local = join(
    homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  return existsSync(local) ? local : null;
}

// Blocker investigation is a core part of Vizor: when a worker reports
// "blocked", a read-only Claude investigation decides whether to route a
// repair, return the worker to its same chat, or hold for the owner.
function investigator(args) {
  check(
    existsSync("vizor.config.json"),
    "Run vizor investigator from a connected project folder.",
  );
  const config = JSON.parse(readFileSync("vizor.config.json", "utf8"));
  const secrets = JSON.parse(
    readFileSync(join(".vizor", "secrets.json"), "utf8"),
  );
  const claude = findClaude(args);
  check(
    claude && existsSync(claude),
    "Claude Code CLI not found. Install it (https://code.claude.com), or pass --claude <path to claude.exe>.",
  );
  const auth = spawnSync(claude, ["auth", "status"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  });
  let signedIn = false;
  try {
    const value = JSON.parse(auth.stdout);
    signedIn = value.loggedIn === true && value.authMethod === "claude.ai";
  } catch {}
  check(
    signedIn,
    "Sign the Claude CLI in to the account that owns the worker routines: claude auth login --claudeai",
  );
  const triggers = {};
  for (const id of Object.keys(config.agents)) {
    const match = /\/routines\/(trig_[A-Za-z0-9_-]+)\/fire$/.exec(
      secrets.agents?.[id]?.fireUrl ?? "",
    );
    check(
      match,
      "Worker " +
        id +
        " has no Fire URL in .vizor/secrets.json yet. Fill in the worker credentials first.",
    );
    triggers[id] = match[1];
  }
  const hostFile = join(".vizor", "orchestrator-host.json");
  const existing = existsSync(hostFile)
    ? JSON.parse(readFileSync(hostFile, "utf8"))
    : {};
  // Keep anything already configured (for example a Codex provider, approved
  // preparation issues or custom timeouts); fill in only what is missing.
  const host = {
    provider: "claude",
    executable: claude,
    timeoutMs: 300000,
    preparationIssues: [],
    ...existing,
    cloudReturn: {
      type: "claude-cloud-cli",
      executable: claude,
      ...existing.cloudReturn,
      triggers: { ...triggers, ...existing.cloudReturn?.triggers },
    },
  };
  if (host.cloudReturn && Array.isArray(host.endedSessions))
    delete host.endedSessions;
  writeFileSync(hostFile + ".tmp", JSON.stringify(host, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(hostFile + ".tmp", hostFile);
  const queueFile = join(".vizor", "queue.json");
  const queue = JSON.parse(readFileSync(queueFile, "utf8"));
  queue.blockerOrchestrator = true;
  writeFileSync(queueFile + ".tmp", JSON.stringify(queue, null, 2) + "\n");
  renameSync(queueFile + ".tmp", queueFile);
  console.log(
    [
      "Blocker investigation is on.",
      "  Investigator: " +
        (host.provider === "claude" ? "Claude" : "Codex") +
        " (" +
        host.executable +
        "), read-only, " +
        Math.round(host.timeoutMs / 1000) +
        "s limit",
      "  Same-chat return: " +
        Object.entries(host.cloudReturn.triggers)
          .map(([id, trigger]) => id + " -> " + trigger)
          .join(", "),
      "When a worker reports blocked, Vizor investigates once and either routes a repair, returns the worker to its chat, or holds the task for you with a report on the issue.",
      "Run vizor doctor to confirm.",
    ].join("\n"),
  );
}

export async function runLifecycle(command, args) {
  if (command === "investigator") return investigator(args);
  if (command === "autonomy") return autonomy(args);
  if (command === "skills") return skills(args);
  if (command === "version") return console.log(runtimeVersion());
  if (command === "versions") return versions();
  if (command === "rollback") return rollback();
  if (command === "connect") return connect(args);
  if (command === "start") return start(args);
  if (command === "stop") return stop();
  if (command === "open") return open(args);
}
