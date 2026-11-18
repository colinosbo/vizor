import { createGitHubClient } from "./github-client.mjs";
import {
  runtimeHealth,
  restartRuntime,
  requireNode24,
} from "./runtime-control.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dashboardSnapshot, serveDashboard } from "./dashboard.mjs";
import {
  runDoctor,
  validTunnelEndpoint,
  validWebhookSecret,
  validWorkerCredentials,
} from "./doctor.mjs";
import {
  createDispatcher,
  createListener,
  openDispatchStore,
} from "./relay.mjs";
import {
  acceptReview,
  openSchedulerStore,
  readQueue,
  retireClaim,
  runScheduler,
} from "./scheduler.mjs";
import { resumeInvestigation } from "./orchestrator.mjs";
import { blockerSnapshot } from "./blockers.mjs";

const secretFile = ".vizor/secrets.json";
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writePrivate = (file, data) =>
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const check = (condition, message) => {
  if (!condition) throw Error(message);
};

let githubClient;
function github(...args) {
  githubClient ??= createGitHubClient();
  return githubClient(...args);
}
github.budget = () => githubClient?.budget() ?? {};

function readConfig() {
  const config = readJson("vizor.config.json");
  check(
    typeof config.repository === "string" &&
      /^[\w.-]+\/[\w.-]+$/.test(config.repository) &&
      config.repository !== "YOUR-GITHUB-OWNER/YOUR-INITIATIVE" &&
      config.repository
        .split("/")
        .every((part) => part !== "." && part !== ".."),
    "Set repository to owner/repo in vizor.config.json.",
  );
  check(
    Number.isInteger(config.port) &&
      config.port >= 1024 &&
      config.port <= 65535,
    "Set a valid local webhook port.",
  );
  check(
    config.agents &&
      typeof config.agents === "object" &&
      !Array.isArray(config.agents) &&
      Object.keys(config.agents).length > 0,
    "Configure at least one agent.",
  );
  const labels = [config.dispatchLabel];
  for (const [id, agent] of Object.entries(config.agents)) {
    check(
      /^[a-z0-9][a-z0-9-]{0,39}$/.test(id) &&
        !Object.hasOwn(Object.prototype, id),
      "Use a lowercase agent ID with letters, numbers and hyphens.",
    );
    check(
      typeof agent?.name === "string" &&
        agent.name.trim() === agent.name &&
        /^[^\r\n]{1,80}$/.test(agent.name),
      "Set a single-line display name for " + id + ".",
    );
    check(
      Array.isArray(agent.trustedManagers) &&
        agent.trustedManagers.length &&
        agent.trustedManagers.every(
          (login) =>
            typeof login === "string" &&
            /^(?!YOUR-GITHUB-LOGIN$)[a-z0-9][a-z0-9-]{0,38}$/i.test(login),
        ),
      "Set trusted GitHub logins for " + id + ".",
    );
    labels.push(agent.label);
  }
  check(
    labels.every(
      (label) =>
        typeof label === "string" && /^[a-z0-9][a-z0-9:_-]{0,49}$/i.test(label),
    ) &&
      new Set(labels.map((label) => label.toLowerCase())).size ===
        labels.length,
    "Use unique GitHub labels of up to 50 characters, regardless of case.",
  );
  return config;
}

function getCredentials(config, verify = true) {
  check(existsSync(secretFile), "Run npm run vizor -- init first.");
  const value = readJson(secretFile);
  check(
    validWebhookSecret(value.webhookSecret) &&
      value.agents &&
      typeof value.agents === "object",
    "Keep the generated webhook secret and agents object in " +
      secretFile +
      ".",
  );
  if (verify) {
    for (const id of Object.keys(config.agents)) {
      const entry = value.agents[id];
      check(
        validWorkerCredentials(entry),
        "Enter the Fire URL and token for " + id + " in " + secretFile + ".",
      );
    }
  }
  return value;
}

async function main() {
  requireNode24();
  const [command, first, second, third] = process.argv.slice(2);
  if (
    ![
      "health",
      "restart",
      "init",
      "serve",
      "setup",
      "assign",
      "status",
      "disconnect",
      "schedule",
      "accept",
      "retire",
      "doctor",
      "dashboard",
      "dashboard-snapshot",
      "orchestrator-resume",
      "orchestrator-status",
    ].includes(command)
  ) {
    console.log(
      "Usage: npm run vizor -- init | serve | setup <Quick Tunnel URL> | assign <issue> <agent ID> <comment ID> | status | disconnect | schedule <queue.json> [--once|--preview] | accept <issue> | retire <queue.json> <issue> | doctor | health [queue.json] | restart | dashboard <queue.json> [port]",
    );
    return;
  }
  const config = readConfig();
  const repo = "repos/" + config.repository;
  const repoKey = createHash("sha256")
    .update(config.repository.toLowerCase())
    .digest("hex");
  const prefix = ".vizor/" + repoKey;
  const hookFile = prefix + "-webhook.json";
  const databaseFile = prefix + ".db";
  if (command === "health" || command === "restart") {
    if (command === "restart")
      restartRuntime({ project: process.cwd(), executable: process.argv[1] });
    const health = runtimeHealth({ project: process.cwd(), file: first });
    console.log(JSON.stringify(health, null, 2));
    if (!health.healthy) process.exitCode = 1;
    return;
  }
  if (command === "dashboard-snapshot") {
    console.log(
      JSON.stringify(
        await dashboardSnapshot({ config, databaseFile, file: first, github }),
      ),
    );
    return;
  }
  if (command === "dashboard") {
    check(first, "Pass the same queue file used by the scheduler.");
    readQueue(first);
    const port = second === undefined ? config.port + 1 : Number(second);
    check(
      Number.isInteger(port) &&
        port >= 1024 &&
        port <= 65535 &&
        port !== config.port,
      "Choose a local dashboard port distinct from the webhook port.",
    );
    serveDashboard({ executable: process.argv[1], queueFile: first, port });
    return;
  }
  if (command === "doctor") {
    const host = existsSync(".vizor/runtime-host.json")
      ? readJson(".vizor/runtime-host.json")
      : null;
    const queue = host?.queue ? readQueue(host.queue) : null;
    check(
      !host || host.mode === (queue?.dispatchMode ?? "webhook"),
      "Installed runtime mode and queue delivery mode disagree. Reinstall the selected mode before restarting the scheduler.",
    );
    const healthy = await runDoctor({
      config,
      secretFile,
      hookFile,
      databaseFile,
      github,
      dispatchMode: queue?.dispatchMode ?? "webhook",
    });
    if (!healthy) process.exitCode = 1;
    return;
  }
  if (command === "init") {
    mkdirSync(".vizor", { recursive: true, mode: 0o700 });
    const credentials = existsSync(secretFile)
      ? getCredentials(config, false)
      : { webhookSecret: randomBytes(32).toString("hex"), agents: {} };
    const missing = Object.keys(config.agents).filter(
      (id) => !Object.hasOwn(credentials.agents, id),
    );
    if (missing.length || !existsSync(secretFile)) {
      for (const id of missing)
        credentials.agents[id] = { fireUrl: "", token: "" };
      writePrivate(secretFile, credentials);
    }
    console.log(
      "Enter each agent's fireUrl and token in " +
        secretFile +
        ". Keep this file private.",
    );
    return;
  }
  if (command === "disconnect") {
    if (!existsSync(hookFile)) {
      console.log("No saved Vizor webhook for this repository.");
      return;
    }
    const saved = readJson(hookFile);
    const existing =
      saved.id && github("GET", repo + "/hooks/" + saved.id, undefined, true);
    if (existing) {
      check(
        existing.config?.url === saved.endpoint,
        "The saved webhook was modified externally. Review it in GitHub before disconnecting.",
      );
      github("DELETE", repo + "/hooks/" + saved.id, undefined, true);
    }
    writePrivate(hookFile, {});
    console.log("Removed the saved Vizor webhook.");
    return;
  }
  const credentials = getCredentials(
    config,
    command === "serve" || command === "setup",
  );
  if (command === "setup") {
    check(
      typeof first === "string" &&
        /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/.test(first),
      "Pass the HTTPS Quick Tunnel URL printed by cloudflared.",
    );
    const endpoint = first.replace(/\/$/, "") + "/webhooks/github";
    for (const name of [
      config.dispatchLabel,
      ...Object.values(config.agents).map((agent) => agent.label),
    ]) {
      if (
        !github(
          "GET",
          repo + "/labels/" + encodeURIComponent(name),
          undefined,
          true,
        )
      )
        github("POST", repo + "/labels", { name, color: "5319e7" });
    }
    const previous = existsSync(hookFile) ? readJson(hookFile) : {};
    const existing =
      previous.id &&
      github("GET", repo + "/hooks/" + previous.id, undefined, true);
    if (existing)
      check(
        existing.config?.url === previous.endpoint,
        "The saved webhook was modified externally. Review it in GitHub before rerunning setup.",
      );
    const settings = {
      active: true,
      events: ["issues", "issue_comment"],
      config: {
        url: endpoint,
        content_type: "json",
        secret: credentials.webhookSecret,
        insecure_ssl: "0",
      },
    };
    const hook = existing
      ? github("PATCH", repo + "/hooks/" + existing.id, settings)
      : github("POST", repo + "/hooks", { name: "web", ...settings });
    writePrivate(hookFile, { id: hook.id, endpoint });
    console.log("GitHub labels and the signed Issues webhook are ready.");
    return;
  }

  const database = openDispatchStore(new DatabaseSync(databaseFile));
  if (command === "orchestrator-resume" || command === "orchestrator-status") {
    try {
      if (command === "orchestrator-resume")
        resumeInvestigation(database, first);
      else console.log(JSON.stringify(blockerSnapshot(database), null, 2));
    } finally {
      database.close();
    }
    return;
  }
  if (["schedule", "accept", "retire"].includes(command)) {
    openSchedulerStore(database);
    try {
      if (command === "accept") return acceptReview(database, Number(first));
      if (command === "retire") {
        const queue = readQueue(first);
        const issue = Number(second);
        check(
          queue.paused && queue.issues.includes(issue),
          "Pause the issue's queue before retiring its claim.",
        );
        return retireClaim(database, issue);
      }
      check(
        first && (!second || ["--once", "--preview"].includes(second)),
        "Use schedule <queue.json> [--once|--preview].",
      );
      const queue = readQueue(first);
      if (queue.dispatchMode === "local") {
        const dispatch = createDispatcher({
          config,
          credentials: getCredentials(config),
          database,
        });
        return await runScheduler({
          db: database,
          config,
          file: first,
          once: Boolean(second),
          preview: second === "--preview",
          github,
          reachable: () => true,
          dispatch: (issue) => dispatch(issue, randomUUID()),
        });
      }
      if (second === "--preview") {
        return await runScheduler({
          db: database,
          config,
          file: first,
          once: true,
          github,
          preview: true,
        });
      }
      const saved = readJson(hookFile);
      check(
        saved.id && validTunnelEndpoint(saved.endpoint),
        "Register the Quick Tunnel with Vizor setup before scheduling.",
      );
      const reachable = async () => {
        try {
          const hook = github("GET", repo + "/hooks/" + saved.id);
          if (
            !hook.active ||
            hook.config?.url !== saved.endpoint ||
            !hook.events.includes("issues")
          )
            return false;
          const response = await fetch(saved.endpoint, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          });
          return (
            response.status === 401 &&
            (await response.json()).error === "Invalid signature."
          );
        } catch {
          return false;
        }
      };
      return await runScheduler({
        db: database,
        config,
        file: first,
        once: second === "--once",
        github,
        reachable,
      });
    } finally {
      database.close();
    }
  }
  if (command === "serve") {
    createListener({ config, credentials, database }).listen(
      config.port,
      "127.0.0.1",
      () => {
        console.log(
          "Vizor webhook listening at http://127.0.0.1:" +
            config.port +
            "/webhooks/github",
        );
      },
    );
    return;
  }
  if (command === "status") {
    console.table(
      database
        .prepare(
          "SELECT a.issue, a.agent, d.delivery, coalesce(d.state, 'ready') AS state, d.session FROM assignments a LEFT JOIN deliveries d USING(issue) ORDER BY a.issue",
        )
        .all(),
    );
    openSchedulerStore(database);
    const scheduled = database
      .prepare(
        "SELECT issue, agent, active, result, pull, accepted FROM scheduled_issues ORDER BY issue",
      )
      .all();
    if (scheduled.length) console.table(scheduled);
    database.close();
    return;
  }
  const issue = Number(first);
  check(
    Number.isSafeInteger(issue) &&
      issue > 0 &&
      Object.hasOwn(config.agents, second) &&
      /^\d+$/.test(third ?? ""),
    "Use assign <issue number> <agent ID> <numeric comment ID>.",
  );
  const agent = config.agents[second];
  const issueData = github("GET", repo + "/issues/" + issue);
  check(
    issueData.state === "open" && !issueData.pull_request,
    "Use an open GitHub issue.",
  );
  const comment = github("GET", repo + "/issues/comments/" + third);
  const expectedIssue =
    "https://api.github.com/" + repo.toLowerCase() + "/issues/" + issue;
  check(
    comment.issue_url?.toLowerCase() === expectedIssue &&
      agent.trustedManagers.some(
        (manager) =>
          manager.toLowerCase() === comment.user?.login?.toLowerCase(),
      ) &&
      comment.body?.split(/\r?\n/).includes("### Task for " + agent.name),
    "The comment must be on this issue, from a trusted manager, with the exact agent heading.",
  );
  const canonical =
    "https://github.com/" +
    config.repository +
    "/issues/" +
    issue +
    "#issuecomment-" +
    third;
  check(
    database
      .prepare(
        "INSERT INTO assignments VALUES (?, ?, ?) ON CONFLICT(issue) DO UPDATE SET agent = excluded.agent, comment = excluded.comment WHERE NOT EXISTS (SELECT 1 FROM deliveries WHERE issue = excluded.issue)",
      )
      .run(issue, second, canonical).changes,
    "This issue has a dispatch receipt. Check its status before creating a fresh pilot issue.",
  );
  database.close();
  console.log(
    "Assignment saved for #" +
      issue +
      ". Add " +
      agent.label +
      " first and " +
      config.dispatchLabel +
      " last.",
  );
}

try {
  await main();
} catch (error) {
  // JSON parser errors can include private file contents.
  console.error(
    error instanceof SyntaxError
      ? "Invalid JSON in a configuration file."
      : error.message,
  );
  process.exitCode = 1;
}

if (githubClient) githubClient.close();
