import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkNode,
  ensureConfig,
  localAddress,
  availablePort,
  acquireLock,
  npmCommand,
} from "./local-runtime.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function sourceFingerprint(folder) {
  const digest = createHash("sha256");
  function add(path) {
    if (!existsSync(path)) return;
    digest.update(relative(folder, path).replaceAll("\\", "/"));
    digest.update(readFileSync(path));
  }
  function walk(folderPath) {
    for (const entry of readdirSync(folderPath, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === "generated") continue;
      const path = join(folderPath, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) add(path);
    }
  }
  for (const directory of ["src", "prisma", "scripts"])
    if (existsSync(join(folder, directory))) walk(join(folder, directory));
  for (const file of [
    "package.json",
    "package-lock.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "prisma.config.ts",
  ])
    add(join(folder, file));
  return digest.digest("hex");
}
function savedJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function openBrowser(url) {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const opener = spawn(command, args, { stdio: "ignore", windowsHide: true });
  opener.on("error", () => console.log(`Open ${url} in your browser.`));
  opener.unref();
}
export async function launch(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "Vizor local launcher\n\nnode scripts/launch.mjs [--no-open] [--repair]\n\nFirst run installs dependencies, prepares your private workspace, builds and opens Vizor. Later runs reuse the installation/build. --repair reinstalls dependencies and rebuilds; it preserves .env and data. Keep the launcher window open; Ctrl+C stops Vizor.",
    );
    return;
  }
  if (args.some((arg) => !["--no-open", "--repair"].includes(arg)))
    throw new Error(
      "Unknown launcher option. Use --help, --no-open or --repair.",
    );
  checkNode();
  process.chdir(root);
  const lock = acquireLock(root);
  let current;
  let stopping = false;
  const terminate = () => {
    if (!current || current.exitCode !== null) return;
    if (process.platform === "win32")
      spawnSync("taskkill.exe", ["/pid", String(current.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else {
      try {
        process.kill(-current.pid, "SIGTERM");
      } catch {
        current.kill("SIGTERM");
      }
    }
  };
  const stop = () => {
    stopping = true;
    terminate();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  async function run(command, arguments_, environment) {
    if (stopping) throw new Error("Vizor was stopped.");
    await new Promise((resolveRun, reject) => {
      current = spawn(command, arguments_, {
        cwd: root,
        stdio: "inherit",
        env: environment,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      current.once("error", () =>
        reject(
          new Error(
            "A required command could not start. Install Node.js 24 with npm, then reopen the launcher.",
          ),
        ),
      );
      current.once("exit", (code, signal) => {
        current = undefined;
        if (code === 0) resolveRun();
        else
          reject(
            new Error(
              stopping
                ? "Vizor was stopped."
                : `Setup stopped (${signal ?? `exit ${code}`}). See the message above. Check your internet connection, disk space and Node.js 24 installation; try the launcher with --repair if necessary.`,
            ),
          );
      });
    });
  }
  try {
    const { config, created } = ensureConfig(root);
    const { origin, port } = localAddress(config);
    await availablePort(port);
    if (created)
      console.log(
        "Created your private .env encryption key. Keep .env and data together when backing up.",
      );
    const environment = {
      ...config,
      NEXT_TELEMETRY_DISABLED: "1",
      CHECKPOINT_DISABLE: "1",
    };
    const installedPath = join(root, "node_modules", ".vizor-install.json");
    const installation = hash(
      `${readFileSync(join(root, "package-lock.json"))}\n${process.versions.modules}\n${process.platform}\n${process.arch}`,
    );
    if (
      args.includes("--repair") ||
      savedJson(installedPath)?.fingerprint !== installation
    ) {
      console.log(
        "Installing Vizor's pinned dependencies. First setup needs internet access and may take a few minutes.",
      );
      const npm = npmCommand(["ci", "--no-audit", "--no-fund"]);
      await run(npm.command, npm.args, environment);
      writeFileSync(
        installedPath,
        JSON.stringify({ fingerprint: installation }),
      );
    }
    console.log("Preparing your local database and checking configuration...");
    await run(process.execPath, [join(root, "scripts/setup.mjs")], environment);
    const buildPath = join(root, "data", ".vizor-build.json");
    const fingerprint = sourceFingerprint(root);
    if (
      args.includes("--repair") ||
      savedJson(buildPath)?.fingerprint !== fingerprint ||
      !existsSync(join(root, ".next", "BUILD_ID"))
    ) {
      console.log("Building Vizor for this computer...");
      const npm = npmCommand(["run", "build"]);
      await run(npm.command, npm.args, environment);
      writeFileSync(buildPath, JSON.stringify({ fingerprint }));
    }
    if (stopping) return;
    console.log(
      `\nStarting Vizor at ${origin}\nKeep this window open. Press Ctrl+C to stop.\n`,
    );
    const serving = run(
      process.execPath,
      [
        join(root, "node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      environment,
    );
    let failure;
    serving.catch((error) => {
      failure = error;
    });
    lock.update({ serverPid: current?.pid, origin });
    let ready = false;
    for (let attempt = 0; attempt < 120 && !failure && !stopping; attempt++) {
      try {
        const response = await fetch(`${origin}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        const result = await response.json();
        if (response.ok && result.app === "vizor" && result.status === "ok") {
          ready = true;
          break;
        }
      } catch {
        /* Server is still starting. */
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (!ready && !stopping) {
      terminate();
      await serving.catch(() => {});
      throw (
        failure ??
        new Error(
          "Vizor did not become ready. Check the message above, then retry with --repair.",
        )
      );
    }
    if (ready) {
      console.log(
        `Ready: ${origin}\nEnter your own provider keys inside the app. Autopilot is off.`,
      );
      if (!args.includes("--no-open")) openBrowser(origin);
    }
    await serving;
  } finally {
    terminate();
    lock.release();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  launch().catch((error) => {
    console.error(`\n${error.message}\n`);
    process.exitCode = 1;
  });
