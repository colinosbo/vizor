import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const validWebhookSecret = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const validWorkerCredentials = (entry) =>
  typeof entry?.fireUrl === "string" &&
  /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/.test(
    entry.fireUrl,
  ) &&
  typeof entry.token === "string" &&
  /^\S+$/.test(entry.token);
const loopbackHost = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;
// Turn the operator's public HTTPS base URL (a reverse proxy or their own
// tunnel) into the relay's webhook endpoint. Returns null when GitHub could
// not deliver to it or the URL carries credentials, a query or a fragment.
export function webhookEndpointFor(base) {
  let url;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    loopbackHost.test(url.hostname)
  )
    return null;
  const path = url.pathname.replace(/\/+$/, "");
  return (
    url.origin +
    (path.endsWith("/webhooks/github") ? path : path + "/webhooks/github")
  );
}
export const validWebhookEndpoint = (value) =>
  typeof value === "string" && webhookEndpointFor(value) === value;

function localCommand(program, ...args) {
  return spawnSync(program, args, {
    timeout: 5000,
    windowsHide: true,
    stdio: "ignore",
  }).status;
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function probe(endpoint, secret, request) {
  const body = "{}";
  try {
    const response = await request(endpoint, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-Hub-Signature-256":
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 200 && (await response.json()).ignored === true)
      return "ok";
    return response.status === 401 ? "rejected" : "unexpected";
  } catch {
    return "unreachable";
  }
}

export async function runDoctor({
  config,
  secretFile,
  hookFile,
  databaseFile,
  github,
  dispatchMode = "webhook",
  request = fetch,
  command = localCommand,
  report = console.log,
  onCheck = () => {},
  investigation,
  mergeRails,
}) {
  let failures = 0;
  function status(ok, label, detail) {
    if (!ok) failures++;
    onCheck({ status: ok ? "pass" : "fail", label, detail });
    report((ok ? "PASS " : "FAIL ") + label + " — " + detail);
    return ok;
  }
  const attempt = (apiPath) => {
    try {
      return github("GET", apiPath, undefined, true);
    } catch {
      return null;
    }
  };

  const nodeVersion = process.versions.node;
  const supportedNode = Number(nodeVersion.split(".")[0]) === 24;
  status(
    supportedNode,
    "Node.js",
    supportedNode ? nodeVersion : "Install Node.js 24.",
  );
  status(
    true,
    "Configuration",
    config.repository +
      " with " +
      Object.keys(config.agents).length +
      " workers.",
  );
  if (investigation) {
    // Blocker investigation is core: without it a blocked task stays held.
    const host = investigation.host;
    const ready =
      investigation.enabled === true &&
      typeof host?.executable === "string" &&
      existsSync(host.executable) &&
      Number.isSafeInteger(host.timeoutMs) &&
      host.timeoutMs >= 1000 &&
      host.timeoutMs <= 900000 &&
      (host.provider === undefined ||
        ["codex", "claude"].includes(host.provider));
    status(
      ready,
      "Blocker investigation",
      ready
        ? "On (" +
            (host.provider === "claude" ? "Claude" : "Codex") +
            ", read-only). Blocked tasks are investigated and routed automatically."
        : !host
          ? "Not set up. Run vizor investigator (needs the Claude CLI signed in)."
          : investigation.enabled !== true
            ? "Configured but off in the queue. Run vizor investigator."
            : "The investigator executable is missing or its settings are invalid. Run vizor investigator again.",
    );
  }
  const ignored = command("git", "check-ignore", "--", secretFile) === 0;
  const cloudHost = loadJson(".vizor/orchestrator-host.json")?.cloudReturn;
  if (cloudHost) {
    let signedIn = false;
    if (
      cloudHost.type === "claude-cloud-cli" &&
      existsSync(cloudHost.executable ?? "")
    ) {
      const result = spawnSync(cloudHost.executable, ["auth", "status"], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 5000,
        maxBuffer: 65536,
      });
      try {
        const value = JSON.parse(result.stdout);
        signedIn =
          result.status === 0 &&
          value.loggedIn === true &&
          value.authMethod === "claude.ai";
      } catch {}
    }
    status(
      signedIn,
      "Claude same-chat subscription",
      signedIn
        ? "Signed in through the supported CLI. Queued return is distinct from provider completion."
        : "Run claude auth login --claudeai with the account owning these cloud sessions. No API-key fallback is used.",
    );
    const bindings = Object.keys(config.agents).every((id) =>
      /^trig_[A-Za-z0-9_-]+$/.test(cloudHost.triggers?.[id] ?? ""),
    );
    status(
      bindings,
      "Provider lifecycle bindings",
      bindings
        ? "Worker trigger IDs are configured; only exact raw provider metadata can establish a completed firing."
        : "Configure cloudReturn.triggers for each saved worker. Idle or stale sessions never prove completion.",
    );
  }
  status(
    ignored,
    "Credential file excluded from Git",
    ignored
      ? "Git ignores the credential file."
      : "Check .gitignore and make sure the credential file is untracked.",
  );
  const credentials = loadJson(secretFile);
  const validSecret = validWebhookSecret(credentials?.webhookSecret);
  const secretOK =
    dispatchMode === "webhook" &&
    status(
      validSecret,
      "Local webhook secret",
      validSecret
        ? "Present and well formed."
        : "Run vizor init if the file is absent. Restore the generated secret if the file is damaged.",
    );
  for (const id of Object.keys(config.agents)) {
    const ready = validWorkerCredentials(credentials?.agents?.[id]);
    status(
      ready,
      "Worker " + id,
      ready
        ? "Fire URL and token are present. Token validity was not tested."
        : "Set this worker's Fire URL and token in .vizor/secrets.json.",
    );
  }
  if (!existsSync(databaseFile)) {
    let writable = false;
    try {
      accessSync(dirname(databaseFile), constants.W_OK);
      writable = true;
    } catch {}
    status(
      writable,
      "Local dispatch state",
      writable
        ? "Not created yet; the runner creates it on first start. The folder is writable."
        : "The .vizor folder is missing or not writable. Run vizor init.",
    );
  } else
    try {
      accessSync(dirname(databaseFile), constants.W_OK);
      accessSync(databaseFile, constants.W_OK);
      const database = new DatabaseSync(databaseFile, { readOnly: true });
      try {
        database.prepare("SELECT issue FROM assignments LIMIT 1").get();
        database.prepare("SELECT issue FROM deliveries LIMIT 1").get();
      } finally {
        database.close();
      }
      status(
        true,
        "Local dispatch state",
        "Database is readable and its path passes the write-access check.",
      );
    } catch {
      status(
        false,
        "Local dispatch state",
        existsSync(databaseFile)
          ? "Check database permissions and integrity on the relay host."
          : "Start the relay from this repository to initialize dispatch state.",
      );
    }

  const ready = command("gh", "--version") === 0;
  status(
    ready,
    "GitHub CLI",
    ready ? "Available on PATH." : "Install GitHub CLI or add it to PATH.",
  );
  const identity = ready ? attempt("user") : null;
  const login =
    typeof identity?.login === "string" &&
    /^[a-z0-9-]{1,39}$/i.test(identity.login)
      ? identity.login
      : null;
  if (ready)
    status(
      Boolean(login),
      "GitHub authentication",
      login
        ? "Signed in as " + login + "."
        : "Run gh auth login or provide the GitHub credentials used by the relay.",
    );
  const repo = "repos/" + config.repository;
  const remote = login ? attempt(repo) : null;
  if (login)
    status(
      Boolean(remote),
      "Repository access",
      remote
        ? "The repository is readable."
        : "Grant this identity access to the configured repository.",
    );
  if (remote) {
    const unmatched = Object.entries(config.agents).filter(
      ([, agent]) =>
        !agent.trustedManagers.some(
          (manager) => manager.toLowerCase() === login.toLowerCase(),
        ),
    );
    status(
      unmatched.length === 0,
      "Trusted manager",
      unmatched.length
        ? "This login cannot dispatch " +
            unmatched.map(([id]) => id).join(", ") +
            "."
        : "This login is configured for every worker. GitHub write permissions were not tested.",
    );
    for (const label of [
      config.dispatchLabel,
      ...Object.values(config.agents).map((agent) => agent.label),
    ]) {
      const found = attempt(repo + "/labels/" + encodeURIComponent(label));
      status(
        found?.name === label,
        "GitHub label " + label,
        found?.name === label
          ? "Present."
          : "Run vizor labels to create it, or check label access and casing.",
      );
    }
  }

  // Standard and braZy rely on GitHub refusing a merge before its checks pass.
  if (remote && mergeRails) {
    const rails = mergeRails();
    status(rails.ok, "Merge rails", rails.detail);
  }

  if (dispatchMode === "local") {
    status(
      true,
      "Local dispatch",
      "The scheduler calls the saved worker directly. No webhook, relay or public endpoint is required; GitHub results are polled.",
    );
    report(
      failures
        ? failures + " check(s) need attention. No workers were triggered."
        : "All diagnostics passed. No workers were triggered.",
    );
    return failures === 0;
  }
  const saved = loadJson(hookFile);
  const registered =
    Number.isSafeInteger(saved?.id) &&
    saved.id > 0 &&
    validWebhookEndpoint(saved.endpoint);
  status(
    registered,
    "Saved webhook",
    registered
      ? "A public webhook endpoint is registered locally."
      : "Run vizor setup with the public HTTPS URL that forwards to this relay, or use local dispatch.",
  );
  if (registered && remote) {
    const hook = attempt(repo + "/hooks/" + saved.id);
    const matches = hook?.config?.url === saved.endpoint;
    const configured =
      matches &&
      hook.active === true &&
      hook.events?.includes("issues") &&
      hook.config.content_type === "json" &&
      String(hook.config.insecure_ssl) === "0";
    status(
      Boolean(configured),
      "GitHub webhook",
      configured
        ? "Active Issues webhook matches the saved endpoint."
        : !hook
          ? "The saved webhook is unavailable. Check repository webhook permissions and GitHub settings."
          : !matches
            ? "GitHub's URL differs from the saved endpoint. Review webhook settings before updating it."
            : "Check that the webhook is active, sends JSON Issues events, and verifies TLS.",
    );
  }
  if (secretOK) {
    const local = "http://127.0.0.1:" + config.port + "/webhooks/github";
    const [relay, publicEndpoint] = await Promise.all([
      probe(local, credentials.webhookSecret, request),
      registered
        ? probe(saved.endpoint, credentials.webhookSecret, request)
        : null,
    ]);
    status(
      relay === "ok",
      "Local relay",
      relay === "ok"
        ? "Accepted a signed ping."
        : relay === "rejected"
          ? "The relay rejected the local secret. Restart it with the current credentials."
          : "Start vizor serve from this repository and check the configured port.",
    );
    if (registered)
      status(
        publicEndpoint === "ok",
        "Public endpoint",
        publicEndpoint === "ok"
          ? "Forwarded a signed ping to the relay."
          : relay !== "ok"
            ? "Fix the local relay first, then rerun doctor."
            : "The saved public URL did not reach this relay. Check your proxy or tunnel and rerun setup if the URL changed.",
      );
  }
  report(
    failures
      ? failures + " check(s) need attention. No workers were triggered."
      : "All diagnostics passed. No workers were triggered.",
  );
  return failures === 0;
}
