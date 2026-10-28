import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import * as util from "node:util";
import { createServer } from "node:net";

export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major !== 24 || minor < 11)
    throw new Error(
      "Vizor needs Node.js 24 LTS (24.11 or later in the 24.x line). Install it from https://nodejs.org/en/download, then reopen this launcher.",
    );
}
/** @typedef {Record<string, string | undefined> & { DATABASE_URL: string, SELF_HOST: string, APP_ORIGIN: string, MASTER_KEY?: string, NEXT_TELEMETRY_DISABLED: string, CHECKPOINT_DISABLE: string }} LocalConfig */
/** @param {string} root @param {Record<string, string | undefined>} [environment] @returns {LocalConfig} */
export function readConfig(root, environment = process.env) {
  const file = join(root, ".env");
  const saved = existsSync(file)
    ? util.parseEnv(readFileSync(file, "utf8"))
    : {};
  return {
    DATABASE_URL: "file:./data/vizor.db",
    SELF_HOST: "true",
    APP_ORIGIN: "http://127.0.0.1:3000",
    ...saved,
    ...environment,
    NEXT_TELEMETRY_DISABLED: "1",
    CHECKPOINT_DISABLE: "1",
  };
}
export function databasePath(root, value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("file:") ||
    value.length <= 5 ||
    value.includes("\0") ||
    /[?#]/.test(value)
  )
    throw new Error(
      "DATABASE_URL must be a local SQLite path beginning with file:. Hosted databases are not supported by this download.",
    );
  return resolve(root, value.slice(5));
}
export function validateConfig(root, config) {
  const key = Buffer.from(config.MASTER_KEY ?? "", "base64");
  if (key.length !== 32 || key.toString("base64") !== config.MASTER_KEY)
    throw new Error(
      "The permanent MASTER_KEY in .env is missing or invalid. Restore your original .env; never replace its key after saving provider credentials. For a fresh install, leave .env creation to the launcher.",
    );
  if (!["true", "false"].includes(config.SELF_HOST))
    throw new Error("SELF_HOST must be true or false in .env.");
  let origin;
  try {
    origin = new URL(config.APP_ORIGIN);
  } catch {
    throw new Error("APP_ORIGIN must be a valid web address in .env.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "APP_ORIGIN must be an http or https origin without a path, password, query or fragment.",
    );
  if (
    config.SELF_HOST === "true" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  )
    throw new Error(
      "Self-host mode must stay on this computer. Use http://127.0.0.1:3000 as APP_ORIGIN.",
    );
  databasePath(root, config.DATABASE_URL);
  return config;
}
/** @param {string} root @param {Record<string, string | undefined>} [environment] */
export function ensureConfig(root, environment = process.env) {
  let config = readConfig(root, environment);
  const file = join(root, ".env");
  let created = false;
  if (!existsSync(file)) {
    if (
      existsSync(databasePath(root, config.DATABASE_URL)) &&
      !config.MASTER_KEY
    )
      throw new Error(
        "Existing data was found without its .env encryption key. Restore the matching .env from your backup before starting Vizor.",
      );
    config = {
      ...config,
      MASTER_KEY: config.MASTER_KEY ?? randomBytes(32).toString("base64"),
    };
    validateConfig(root, config);
    const values = [
      "DATABASE_URL",
      "SELF_HOST",
      "APP_ORIGIN",
      "MASTER_KEY",
      "NEXT_TELEMETRY_DISABLED",
      "CHECKPOINT_DISABLE",
    ];
    writeFileSync(
      file,
      values
        .map((name) => `${name}=${JSON.stringify(config[name])}`)
        .join("\n") + "\n",
      { flag: "wx", mode: 0o600 },
    );
    created = true;
  }
  validateConfig(root, config);
  return { config, created };
}
export function localAddress(config) {
  const url = new URL(config.APP_ORIGIN);
  const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error(
      'The local launcher needs an HTTP loopback address and a port from 1024 to 65535. Use APP_ORIGIN="http://127.0.0.1:3000" in .env.',
    );
  return { origin: url.origin, port };
}
export async function availablePort(port) {
  await new Promise((resolveReady, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is already in use. Close the other Vizor window or app first, or choose another port in APP_ORIGIN in .env. No existing app was stopped.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolveReady));
  });
}
export function acquireLock(root) {
  const folder = join(root, "data");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, ".vizor-launch.lock");
  const nonce = randomBytes(16).toString("hex");
  const record = {
    pid: process.pid,
    nonce,
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let saved;
      try {
        saved = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          "Vizor's launch lock could not be read. Close its other launcher windows before removing data/.vizor-launch.lock.",
        );
      }
      if (!Number.isSafeInteger(saved.pid) || saved.pid < 1)
        throw new Error(
          "Vizor's launch lock is invalid. Close other launchers before removing data/.vizor-launch.lock.",
        );
      let alive = true;
      try {
        process.kill(saved.pid, 0);
      } catch (failure) {
        if (failure.code === "ESRCH") alive = false;
      }
      if (alive || attempt)
        throw new Error(
          "Vizor is already running or being set up from this folder. Use its existing window; close it before starting again.",
        );
      unlinkSync(file);
    }
  }
  return {
    update(values) {
      writeFileSync(file, JSON.stringify({ ...record, ...values }), {
        mode: 0o600,
      });
    },
    release() {
      try {
        if (JSON.parse(readFileSync(file, "utf8")).nonce === nonce)
          unlinkSync(file);
      } catch {
        /* Never remove a different launcher's lock. */
      }
    },
  };
}
export function npmCommand(args, platform = process.platform) {
  if (args.some((value) => !/^[a-zA-Z0-9_.:/=-]+$/.test(value)))
    throw new Error("Unsupported package-manager argument.");
  return platform === "win32"
    ? {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", `npm ${args.join(" ")}`],
      }
    : { command: "npm", args };
}
