import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { processAlive } from "./runner-lease.mjs";
import { readRuntimeSnapshot } from "./runtime-snapshot.mjs";

// Installed layout (code only; project state never lives here):
//   <home>/versions/<version>/   immutable runtime files + manifest.json
//   <home>/install.json          current/previous version and registered projects
//   <home>/bin/vizor(.cmd)       stable CLI shims pointing at the current version
//   <home>/install.lock/         held while installing, upgrading or rolling back
export const INSTALL_SCHEMA = "vizor.install/1";
export const PACKAGE_SCHEMA = "vizor.package/1";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function vizorHome({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env.VIZOR_HOME) return resolve(env.VIZOR_HOME);
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
      "Vizor",
    );
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "vizor");
}

export const runtimeRoot = () =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runtimeVersion(root = runtimeRoot()) {
  const file = join(root, "VERSION");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return "source";
}

export function hashTree(root) {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else
        files[relative(root, path).split(sep).join("/")] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(root);
  return files;
}

// Every file the manifest lists must exist with the recorded hash, and the
// runtime may contain nothing the manifest does not list.
export function verifyRuntime(root, manifest) {
  if (
    manifest?.schema !== PACKAGE_SCHEMA ||
    !VERSION_PATTERN.test(manifest.version)
  )
    throw Error(
      "Not a Vizor runtime package (manifest schema or version invalid).",
    );
  const actual = hashTree(root);
  delete actual["manifest.json"];
  const expected = manifest.files ?? {};
  const problems = [];
  for (const [file, hash] of Object.entries(expected))
    if (actual[file] !== hash)
      problems.push((actual[file] ? "changed " : "missing ") + file);
  for (const file of Object.keys(actual))
    if (!Object.hasOwn(expected, file)) problems.push("unexpected " + file);
  if (problems.length)
    throw Error(
      "Runtime files do not match the package manifest: " +
        problems.slice(0, 5).join(", "),
    );
  if (readFileSync(join(root, "VERSION"), "utf8").trim() !== manifest.version)
    throw Error("VERSION file does not match the manifest.");
  return manifest;
}

export function readPackage(packageDir) {
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "manifest.json"), "utf8"),
  );
  return verifyRuntime(join(packageDir, "runtime"), manifest);
}

const atomicWrite = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  writeFileSync(temp, text, { flag: "wx" });
  renameSync(temp, file);
};

export function readInstall(home) {
  const file = join(home, "install.json");
  if (!existsSync(file))
    return {
      schema: INSTALL_SCHEMA,
      current: null,
      previous: null,
      projects: [],
    };
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.schema !== INSTALL_SCHEMA)
    throw Error("Unknown install.json schema.");
  return data;
}

export function writeInstall(home, data) {
  atomicWrite(join(home, "install.json"), JSON.stringify(data, null, 2) + "\n");
}

export const versionDir = (home, version) => join(home, "versions", version);

// Cross-process lock for install, upgrade and rollback. A lock left by a dead
// process on this host, or older than 15 minutes, is reclaimed.
export function withInstallLock(
  home,
  fn,
  { alive = processAlive, now = Date.now } = {},
) {
  mkdirSync(home, { recursive: true });
  const lock = join(home, "install.lock");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt) {
        if (error.code === "EEXIST")
          throw Error(
            "Another Vizor install, upgrade or rollback is running (" +
              lock +
              ").",
          );
        throw error;
      }
      let owner = null;
      try {
        owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
      } catch {}
      const stale =
        !owner ||
        now() - owner.at > 15 * 60000 ||
        (owner.host === hostname() && !alive(owner.pid));
      if (!stale)
        throw Error(
          "Another Vizor install, upgrade or rollback is running (pid " +
            owner.pid +
            ").",
        );
      rmSync(lock, { recursive: true, force: true });
    }
  }
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, host: hostname(), at: now() }),
  );
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Copy a verified package runtime into its immutable version directory.
export function installFiles(packageDir, home) {
  const manifest = readPackage(packageDir);
  const target = versionDir(home, manifest.version);
  if (existsSync(target)) {
    // Same version already installed: it must be byte-identical.
    verifyRuntime(
      target,
      JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")),
    );
    const installed = JSON.parse(
      readFileSync(join(target, "manifest.json"), "utf8"),
    );
    if (JSON.stringify(installed.files) !== JSON.stringify(manifest.files))
      throw Error(
        "Version " +
          manifest.version +
          " is already installed with different files. Use a new version number.",
      );
    return { version: manifest.version, dir: target, reused: true };
  }
  const temp = join(
    home,
    "versions",
    "." + manifest.version + "." + randomUUID(),
  );
  mkdirSync(temp, { recursive: true });
  try {
    cpSync(join(packageDir, "runtime"), temp, { recursive: true });
    writeFileSync(
      join(temp, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    verifyRuntime(temp, manifest);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { version: manifest.version, dir: target, reused: false };
}

export function writeShims(home, dir) {
  const script = join(dir, "scripts", "vizor.mjs");
  // One line: cmd.exe re-reads a batch file after each line, and upgrade or
  // rollback rewrites this shim while it may be running.
  atomicWrite(
    join(home, "bin", "vizor.cmd"),
    '@node "' + script + '" %* & exit /b\r\n',
  );
  atomicWrite(
    join(home, "bin", "vizor"),
    '#!/bin/sh\nexec node "' + script + '" "$@"\n',
  );
  try {
    spawnSync("chmod", ["755", join(home, "bin", "vizor")]);
  } catch {}
}

// Switch every registered project to `version`. Each project is stopped,
// reinstalled from the target version and must publish a heartbeat from the
// target runtime. If any project fails, projects already switched are moved
// back to the version they were on. Project state is never copied or rewritten.
export function activate(home, version, ops, log = console.log) {
  const install = readInstall(home);
  const dir = versionDir(home, version);
  if (!existsSync(join(dir, "manifest.json")))
    throw Error("Version " + version + " is not installed.");
  verifyRuntime(
    dir,
    JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
  );
  const from = install.current;
  const switched = [];
  if (ops) {
    for (const project of install.projects) {
      try {
        log("Switching " + project + " to " + version + "...");
        ops.switchProject(project, dir);
        switched.push(project);
      } catch (error) {
        log("Failed to switch " + project + ": " + error.message);
        if (from) {
          for (const done of [...switched, project]) {
            try {
              ops.switchProject(done, versionDir(home, from));
              log("Restored " + done + " to " + from + ".");
            } catch (restore) {
              log(
                "Could not restore " +
                  done +
                  ": " +
                  restore.message +
                  " Run `vizor doctor` there.",
              );
            }
          }
        }
        throw Error(
          "Activation of " +
            version +
            " stopped; projects were returned to " +
            (from ?? "their previous state") +
            ".",
        );
      }
    }
  } else if (install.projects.length) {
    log(
      "Supervision is not managed on this platform; restart registered runners manually.",
    );
  }
  writeShims(home, dir);
  writeInstall(home, {
    ...install,
    current: version,
    previous: from && from !== version ? from : install.previous,
  });
  return { from, to: version, projects: switched };
}

export function registerProject(home, project) {
  const install = readInstall(home);
  const path = resolve(project);
  if (!install.projects.some((p) => p.toLowerCase() === path.toLowerCase()))
    writeInstall(home, { ...install, projects: [...install.projects, path] });
}

export function installedVersions(home) {
  const root = join(home, "versions");
  return existsSync(root)
    ? readdirSync(root)
        .filter((name) => VERSION_PATTERN.test(name))
        .sort()
    : [];
}

// Windows supervision: reuse the existing task scripts from the target version.
export function windowsOps({
  execute = spawnSync,
  wait = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  timeoutMs = 90000,
} = {}) {
  const powershell = (script, args) => {
    const result = execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        ...args,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 180000 },
    );
    if (result.error || result.status !== 0)
      throw Error(
        ((result.stdout || "") + (result.stderr || "")).trim() ||
          script + " failed",
      );
    return result.stdout;
  };
  return {
    switchProject(project, dir) {
      const host = JSON.parse(
        readFileSync(join(project, ".vizor", "runtime-host.json"), "utf8"),
      );
      powershell(join(dir, "windows", "stop.ps1"), ["-ProjectPath", project]);
      const args = [
        "-ProjectPath",
        project,
        "-QueuePath",
        host.queue,
        "-Mode",
        host.mode || "local",
      ];
      if (host.prefix) args.push("-TaskPrefix", host.prefix);
      if (host.webhookUrl) args.push("-WebhookUrl", host.webhookUrl);
      powershell(join(dir, "windows", "install.ps1"), args);
      waitForRunner(project, host.queue, dir, { wait, timeoutMs });
    },
  };
}

// The runner is up on `dir` when a live scheduler from that runtime publishes a
// fresh heartbeat.
export function waitForRunner(
  project,
  queue,
  dir,
  { wait, timeoutMs = 90000, now = Date.now } = {},
) {
  const expected = resolve(dir, "scripts", "vizor.mjs").toLowerCase();
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = readRuntimeSnapshot(resolve(project, queue));
    if (
      state.snapshot &&
      !state.stale &&
      String(state.snapshot.executable).toLowerCase() === expected
    )
      return state.snapshot;
    if (now() > deadline)
      throw Error(
        "The runner did not publish a heartbeat from " +
          dir +
          " within " +
          Math.round(timeoutMs / 1000) +
          "s. Check .vizor/host-scheduler.log.",
      );
    wait(1000);
  }
}

export function defaultOps({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (env.VIZOR_SUPERVISOR === "none" || platform !== "win32") return null;
  return windowsOps();
}
