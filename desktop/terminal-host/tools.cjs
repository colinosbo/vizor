const {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
} = require("node:fs");
const { join, isAbsolute, basename, resolve, sep } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const releases = {
  "claude-code": {
    version: "2.1.308",
    file: "claude.exe",
    url: "https://downloads.claude.ai/claude-code-releases/2.1.308/win32-x64/claude.exe",
    sha256: "c9796ba22a9221586b36371b36f5b66198d66eb4badf6a4cf4a5f7b07becea53",
  },
  codex: {
    version: "0.165.0",
    file: "bin/codex.exe",
    archive: true,
    url: "https://github.com/openai/codex/releases/download/rust-v0.165.0/codex-package-x86_64-pc-windows-msvc.tar.gz",
    sha256: "2a64beb5856c3170738793e0aa65b44aa3f2d7b8f53221a3f72bdafe6485d119",
  },
};
function spec(engine) {
  if (!Object.hasOwn(releases, engine)) throw Error("Unknown engine");
  return releases[engine];
}
const codexFiles = [
  "bin/codex.exe",
  "bin/codex-code-mode-host.exe",
  "codex-resources/codex-command-runner.exe",
  "codex-resources/codex-windows-sandbox-setup.exe",
  "codex-path/rg.exe",
  "codex-package.json",
];
function location(engine, home) {
  const release = spec(engine);
  return resolve(
    home,
    "tools",
    engine,
    release.version + (release.archive ? "-package" : ""),
  );
}
function completeCodex(directory) {
  return codexFiles.every(
    (file) =>
      existsSync(join(directory, file)) &&
      statSync(join(directory, file)).isFile(),
  );
}
function findTool(engine, home, env = process.env) {
  const release = spec(engine);
  const directory = location(engine, home),
    managed = join(directory, release.file);
  const paths = [
    ...(!release.archive || completeCodex(directory) ? [managed] : []),
    ...String(env.PATH || env.Path || "")
      .split(";")
      .filter(isAbsolute)
      .map((p) => join(p, basename(release.file))),
  ];
  if (engine === "claude-code")
    paths.push(
      join(env.USERPROFILE || home, ".local/bin/claude.exe"),
      join(
        env.APPDATA || home,
        "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      ),
    );
  if (engine === "codex") {
    const result = spawnSync(
      join(env.SystemRoot || "C:/Windows", "System32/where.exe"),
      ["codex.exe"],
      { encoding: "utf8", windowsHide: true, timeout: 3000 },
    );
    paths.push(
      ...String(result.stdout || "")
        .trim()
        .split(/\r?\n/)
        .filter(isAbsolute),
    );
  }
  return paths.find((p) => existsSync(p)) || null;
}
function installBytes(engine, home, bytes) {
  const release = spec(engine);
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256)
    throw Error(
      "The official tool checksum did not match. Nothing was installed.",
    );
  const directory = location(engine, home),
    parent = resolve(home, "tools", engine);
  if (!directory.startsWith(parent + sep))
    throw Error("Invalid tool directory");
  mkdirSync(parent, { recursive: true });
  if (!release.archive) {
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `download-${randomUUID()}.tmp`);
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, join(directory, release.file));
    return join(directory, release.file);
  }
  // Authenticate before extraction and preserve the complete official layout.
  const staging = join(parent, `download-${randomUUID()}`);
  mkdirSync(staging);
  try {
    const archive = join(staging, "package.tar.gz");
    writeFileSync(archive, bytes, { flag: "wx" });
    const tar = join(
      process.env.SystemRoot || "C:/Windows",
      "System32/tar.exe",
    );
    const listing = spawnSync(tar, ["-tzf", archive], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 2000000,
    });
    const names = String(listing.stdout || "")
      .trim()
      .split(/\r?\n/);
    if (
      listing.status !== 0 ||
      names.length > 300 ||
      names.some(
        (name) =>
          !/^[a-zA-Z0-9_./-]+$/.test(name) ||
          name.startsWith("/") ||
          name.split("/").includes(".."),
      )
    )
      throw Error(
        "The verified Codex package could not be inspected. Windows 11 tar is required.",
      );
    const extracted = spawnSync(tar, ["-xzf", archive, "-C", staging], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 60000,
    });
    if (extracted.status !== 0 || !completeCodex(staging))
      throw Error("The Codex native package is incomplete. Try Set up again.");
    rmSync(archive);
    writeFileSync(
      join(staging, "vizor-verified.json"),
      JSON.stringify({ sha256: release.sha256 }),
    );
    // Only the resolved, managed binary directory; never a selected project.
    if (existsSync(directory)) rmSync(directory, { recursive: true });
    renameSync(staging, directory);
    return join(directory, release.file);
  } finally {
    if (resolve(staging).startsWith(parent + sep))
      rmSync(staging, { recursive: true, force: true });
  }
}
async function installTool(engine, home, progress = () => {}) {
  const release = spec(engine);
  const directory = location(engine, home),
    existing = join(directory, release.file);
  let cached = false;
  try {
    cached = release.archive
      ? completeCodex(directory) &&
        JSON.parse(readFileSync(join(directory, "vizor-verified.json"), "utf8"))
          .sha256 === release.sha256
      : existsSync(existing) &&
        createHash("sha256").update(readFileSync(existing)).digest("hex") ===
          release.sha256;
  } catch {}
  if (cached) {
    progress(100);
    return existing;
  }
  const response = await fetch(release.url, {
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok)
    throw Error("Official download is unavailable. Try again later.");
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  const total = Number(response.headers.get("content-length") || 0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 600 * 1024 * 1024) {
      await reader.cancel();
      throw Error("Download exceeds the expected size");
    }
    chunks.push(Buffer.from(value));
    progress(total ? Math.min(99, Math.round((size * 100) / total)) : null);
  }
  const target = installBytes(engine, home, Buffer.concat(chunks));
  progress(100);
  return target;
}
module.exports = { releases, findTool, installTool, installBytes };
