import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function parseResponse(stdout = "") {
  const match = stdout.match(
    /^HTTP\/\S+\s+(\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/,
  );
  if (!match) return { status: null, headers: {}, body: stdout };
  return {
    status: Number(match[1]),
    headers: Object.fromEntries(
      match[2].split(/\r?\n/).map((line) => {
        const colon = line.indexOf(":");
        return [
          line.slice(0, colon).toLowerCase(),
          line.slice(colon + 1).trim(),
        ];
      }),
    ),
    body: match[3],
  };
}

// Authentication is performed by gh; only its credential fingerprint namespaces the
// private cache. Never persist or print the credential itself.
export function createGitHubClient({
  file = ".vizor/github-cache.db",
  execute = spawnSync,
  now = Date.now,
  scope,
  executable = "gh",
} = {}) {
  if (!scope) {
    const token =
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN ||
      execute(executable, ["auth", "token"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30000,
      }).stdout?.trim();
    if (!token)
      throw Error("GitHub authentication unavailable. Run gh auth status.");
    scope = createHash("sha256")
      .update((process.env.GH_HOST || "github.com") + "\0" + token)
      .digest("hex");
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS github_cache (scope TEXT,path TEXT,etag TEXT,json TEXT,PRIMARY KEY(scope,path)); CREATE TABLE IF NOT EXISTS github_budget (scope TEXT PRIMARY KEY,json TEXT);",
  );
  let state = JSON.parse(
    db.prepare("SELECT json FROM github_budget WHERE scope=?").get(scope)
      ?.json || "{}",
  );
  const save = () =>
    db
      .prepare("INSERT OR REPLACE INTO github_budget VALUES (?,?)")
      .run(scope, JSON.stringify(state));
  function github(method, path, body, allowMissing = false) {
    if (
      !/^(repos\/[\w.-]+\/[\w.-]+(?:\/|$)|user$|rate_limit$)/.test(path) ||
      /[\r\n]/.test(path)
    )
      throw Error("Invalid GitHub API path.");
    if (state.backoffUntil > now())
      throw Error(
        `GitHub request held until ${new Date(state.backoffUntil).toISOString()} (HTTP ${state.status ?? "budget"}; remaining ${state.remaining ?? "unknown"}).`,
      );
    const cached =
      method === "GET"
        ? db
            .prepare("SELECT * FROM github_cache WHERE scope=? AND path=?")
            .get(scope, path)
        : null;
    const args = ["api", "--include", "-X", method, path];
    if (cached?.etag && !/[\r\n]/.test(cached.etag))
      args.push("-H", "If-None-Match: " + cached.etag);
    if (body !== undefined) args.push("--input", "-");
    const result = execute(executable, args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const response = parseResponse(result.stdout);
    const status =
      response.status ||
      Number(result.stderr?.match(/HTTP (\d{3})/)?.[1]) ||
      null;
    const h = response.headers;
    if (h["x-ratelimit-remaining"] !== undefined)
      state.remaining = Number(h["x-ratelimit-remaining"]);
    if (h["x-ratelimit-reset"])
      state.reset = Number(h["x-ratelimit-reset"]) * 1000;
    state.status = status;
    if (status === 403 || status === 429 || status >= 500) {
      const retry = h["retry-after"];
      const retryAt = retry
        ? /^\d+$/.test(retry)
          ? now() + Number(retry) * 1000
          : Date.parse(retry)
        : 0;
      // Secondary limits can occur with a nonzero primary budget.
      state.backoffUntil = Math.max(
        now() + 60000,
        retryAt || 0,
        state.remaining === 0 ? state.reset || 0 : 0,
      );
    } else if (state.remaining === 0 && state.reset > now())
      state.backoffUntil = state.reset;
    if (status === 304 && cached) {
      state.lastSuccessfulSync = new Date(now()).toISOString();
      save();
      return JSON.parse(cached.json);
    }
    if (status === 404 && allowMissing) {
      save();
      return null;
    }
    if (result.error || result.status !== 0 || !status || status >= 400) {
      save();
      throw Error(
        `GitHub ${method} failed (HTTP ${status ?? "unavailable"}; remaining ${state.remaining ?? "unknown"}; reset ${state.reset ? new Date(state.reset).toISOString() : "unknown"}${state.backoffUntil > now() ? "; retry after " + new Date(state.backoffUntil).toISOString() : ""}). ${status === 401 ? "Run gh auth status." : status === 403 || status === 429 ? "Check rate budget, Retry-After and repository permissions." : result.error ? "GitHub CLI failed or timed out; check connectivity and gh installation." : "Check repository access or API availability."}`,
      );
    }
    if (status === 304)
      throw Error(
        "GitHub returned HTTP 304 without a cached representation; clear the private GitHub cache and retry.",
      );
    let value;
    try {
      value = response.body.trim() ? JSON.parse(response.body) : undefined;
    } catch {
      throw Error(
        "GitHub returned invalid JSON (HTTP " +
          status +
          "). Check API availability.",
      );
    }
    state.lastSuccessfulSync = new Date(now()).toISOString();
    if (method === "GET" && value !== undefined)
      db.prepare("INSERT OR REPLACE INTO github_cache VALUES (?,?,?,?)").run(
        scope,
        path,
        h.etag || null,
        JSON.stringify(value),
      );
    save();
    return value;
  }
  github.budget = () => ({ ...state });
  github.close = () => db.close();
  return github;
}
