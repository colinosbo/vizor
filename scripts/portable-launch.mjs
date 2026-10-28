import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  ensureConfig,
  databasePath,
  localAddress,
  availablePort,
} from "./lib/local-runtime.mjs";
import { migrate } from "./lib/portable-migrate.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const desktop =
  process.argv.includes("--desktop") && typeof process.send === "function";
const workspace =
  desktop && process.env.VIZOR_WORKSPACE
    ? resolve(process.env.VIZOR_WORKSPACE)
    : root;
if (desktop && !isAbsolute(process.env.VIZOR_WORKSPACE ?? ""))
  throw new Error("The desktop workspace must be an absolute local path.");
let child;
let lock;
let stopping = false;
let activityDatabase;
let activityDatabasePath;
const system = (name) =>
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child || child.exitCode !== null) {
    lock?.release();
    return;
  }
  if (process.platform === "win32")
    spawnSync(system("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", () => lock?.release());
if (desktop) {
  process.on("message", (message) => {
    if (message?.type === "stop") stop();
    if (
      message?.type === "update-activity" &&
      typeof message.id === "string" &&
      message.id.length < 100
    ) {
      let active = null;
      if (!stopping && activityDatabase && child && child.exitCode === null) {
        let check;
        try {
          check = new activityDatabase(activityDatabasePath, {
            readonly: true,
          });
          active = check
            .prepare("SELECT COUNT(*) AS n FROM Run WHERE status = 'running'")
            .get().n;
        } catch {
          /* Unknown activity blocks a requested update restart. */
        } finally {
          check?.close();
        }
      }
      if (process.connected)
        process.send({ type: "update-activity", id: message.id, active });
    }
  });
  process.on("disconnect", stop);
}
try {
  const manifest = JSON.parse(
    readFileSync(join(root, "vizor-portable.json"), "utf8"),
  );
  if (
    process.platform !== manifest.platform ||
    process.arch !== manifest.arch ||
    process.versions.modules !== manifest.moduleABI
  )
    throw new Error(
      "This download is for a different computer. Choose the Vizor download matching your operating system and processor.",
    );
  const server = join(root, "app/server.js");
  if (!existsSync(server) || !existsSync(join(root, "app/.next/BUILD_ID")))
    throw new Error(
      "The app files are missing. Extract the whole download before opening Start Vizor.",
    );
  const { config } = ensureConfig(workspace);
  const { origin, port } = localAddress(config);
  await availablePort(port);
  lock = acquireLock(workspace);
  const database = databasePath(workspace, config.DATABASE_URL);
  const requireApp = createRequire(join(root, "app/package.json"));
  activityDatabase = requireApp("better-sqlite3");
  activityDatabasePath = database;
  const result = await migrate({
    database,
    migrations: join(root, "migrations"),
    Database: activityDatabase,
  });
  if (process.platform !== "win32") chmodSync(database, 0o600);
  if (result.backup)
    console.log(
      "A backup was saved in your database's backups folder before upgrading.",
    );
  if (stopping) throw new Error("Vizor startup was stopped.");
  console.log(
    `Starting Vizor ${manifest.version}. Keys and conversations stay in this folder.`,
  );
  child = spawn(process.execPath, [server], {
    cwd: join(root, "app"),
    env: {
      ...config,
      NODE_ENV: "production",
      DATABASE_URL: `file:${database.replaceAll("\\", "/")}`,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", () => {
    console.error(
      "Vizor could not start its bundled server. Extract the whole download again.",
    );
    stop();
    process.exitCode = 1;
  });
  const ended = new Promise((done) =>
    child.once("exit", (code) => {
      lock?.release();
      if (!stopping) process.exitCode = code || 1;
      done();
    }),
  );
  let ready = false;
  for (
    let attempt = 0;
    attempt < 120 && child.exitCode === null && !stopping;
    attempt++
  ) {
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      const health = await response.json();
      if (
        response.ok &&
        health.app === "vizor" &&
        health.version === manifest.version
      ) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the local server only. */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  if (!ready && !stopping) {
    stop();
    throw new Error(
      "Vizor did not become ready. Check the message above, then reopen the launcher.",
    );
  }
  if (ready) {
    if (desktop) process.send({ type: "ready", origin });
    console.log(
      `Vizor is ready: ${origin}\nKeep this window open. Press Ctrl+C to stop.`,
    );
    if (!process.argv.includes("--no-open")) {
      const command =
        process.platform === "win32"
          ? system("rundll32.exe")
          : process.platform === "darwin"
            ? "/usr/bin/open"
            : "xdg-open";
      const args =
        process.platform === "win32"
          ? ["url.dll,FileProtocolHandler", origin]
          : [origin];
      const browser = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      browser.on("error", () => console.log(`Open ${origin} in your browser.`));
      browser.unref();
    }
  }
  await ended;
} catch (error) {
  stop();
  console.error(
    error instanceof Error ? error.message : "Vizor could not start.",
  );
  process.exitCode = 1;
} finally {
  lock?.release();
  if (desktop && process.connected) process.disconnect();
}
