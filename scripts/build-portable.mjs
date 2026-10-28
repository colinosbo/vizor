// Run on the target OS/CPU after npm ci, setup, and build. Never ships npm.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as util from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;
const nodeVersion = "24.22.1";
const targets = {
  "win32-x64": "windows-x64",
  "darwin-x64": "macos-x64",
  "darwin-arm64": "macos-arm64",
  "linux-x64": "linux-x64",
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target || process.versions.modules !== "137")
  throw new Error("Build using Node 24 on a supported target OS and CPU.");
const source = join(root, ".next/standalone");
if (!existsSync(join(source, "server.js")))
  throw new Error("Run npm run build first to create the standalone app.");
const artifacts = join(root, "artifacts");
const staging = join(artifacts, `portable-build-${randomUUID()}`);
const name = `vizor-v${version}-${target}`;
const bundle = join(staging, name);
mkdirSync(join(bundle, "runtime"), { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Packaging operation failed: ${basename(command)}`);
}
async function download(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Runtime download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
const nodeName = `node-v${nodeVersion}-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const nodeArchive = `${nodeName}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
const base = `https://nodejs.org/download/release/v${nodeVersion}/`;
const sums = (await download(`${base}SHASUMS256.txt`)).toString("utf8");
const expected = sums
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find(([, file]) => file === nodeArchive)?.[0];
if (!/^[a-f0-9]{64}$/.test(expected ?? ""))
  throw new Error("Official Node runtime checksum was not found.");
const archive = await download(`${base}${nodeArchive}`);
if (createHash("sha256").update(archive).digest("hex") !== expected)
  throw new Error("Official Node runtime checksum verification failed.");
writeFileSync(join(staging, nodeArchive), archive);
run(
  process.platform === "win32"
    ? join(process.env.SystemRoot, "System32/tar.exe")
    : "/usr/bin/tar",
  ["-xf", join(staging, nodeArchive), "-C", staging],
);
const runtimeName = process.platform === "win32" ? "node.exe" : "node";
cpSync(
  join(
    staging,
    nodeName,
    process.platform === "win32" ? runtimeName : `bin/${runtimeName}`,
  ),
  join(bundle, "runtime", runtimeName),
);
cpSync(join(staging, nodeName, "LICENSE"), join(bundle, "runtime/LICENSE"));
chmodSync(join(bundle, "runtime", runtimeName), 0o755);
const runtimeCheck = spawnSync(
  join(bundle, "runtime", runtimeName),
  [
    "-p",
    "JSON.stringify({version:process.versions.node,abi:process.versions.modules})",
  ],
  { encoding: "utf8", windowsHide: true },
);
if (
  runtimeCheck.status !== 0 ||
  JSON.parse(runtimeCheck.stdout).version !== nodeVersion ||
  JSON.parse(runtimeCheck.stdout).abi !== "137"
)
  throw new Error("Bundled runtime did not pass verification.");
cpSync(source, join(bundle, "app"), {
  recursive: true,
  dereference: true,
  filter: (path) => {
    const parts = relative(source, path).split(/[\\/]/);
    return (
      !parts.some(
        (part) => part.startsWith(".env") || /\.db(?:-|$)/.test(part),
      ) && parts[0] !== "data"
    );
  },
});
// Argon2 builds locally on Intel Macs. Tracing dynamic native loaders can omit
// build/Release, including Next's relocated package copies. Populate every copy.
const nativePackages = [];
function includeNativeBinaries(folder) {
  const metadata = join(folder, "package.json");
  if (existsSync(metadata)) {
    const pkg = JSON.parse(readFileSync(metadata, "utf8"));
    if (["argon2", "better-sqlite3"].includes(pkg.name)) {
      nativePackages.push(folder);
      const compiled = join(root, "node_modules", pkg.name, "build/Release");
      if (existsSync(compiled)) {
        const destination = join(folder, "build/Release");
        mkdirSync(destination, { recursive: true });
        for (const file of readdirSync(compiled).filter((file) =>
          file.endsWith(".node"),
        ))
          cpSync(join(compiled, file), join(destination, file));
      }
    }
  }
  for (const entry of readdirSync(folder, { withFileTypes: true }))
    if (entry.isDirectory()) includeNativeBinaries(join(folder, entry.name));
}
includeNativeBinaries(join(bundle, "app"));
const nativeCheck = spawnSync(
  join(bundle, "runtime", runtimeName),
  [
    "--input-type=commonjs",
    "-e",
    `const {createRequire}=require('node:module'); const fs=require('node:fs'); for(const folder of process.argv.slice(1)){ const req=createRequire(folder+'/package.json'); const p=JSON.parse(fs.readFileSync(folder+'/package.json')); const loaded=req(folder+'/'+p.main); if(p.name==='better-sqlite3'){const db=new loaded(':memory:');db.close();} }`,
    ...nativePackages,
  ],
  { encoding: "utf8", windowsHide: true },
);
if (nativeCheck.status !== 0)
  throw new Error(
    "A bundled native dependency failed its runtime load check. No release archive was created.",
  );
cpSync(join(root, ".next/static"), join(bundle, "app/.next/static"), {
  recursive: true,
});
if (existsSync(join(root, "public")))
  cpSync(join(root, "public"), join(bundle, "app/public"), { recursive: true });
mkdirSync(join(bundle, "lib"));
cpSync(
  join(root, "scripts/portable-launch.mjs"),
  join(bundle, "portable-launch.mjs"),
);
for (const file of ["local-runtime.mjs", "portable-migrate.mjs"])
  cpSync(join(root, "scripts", file), join(bundle, "lib", file));
cpSync(join(root, "prisma/migrations"), join(bundle, "migrations"), {
  recursive: true,
});
for (const file of ["LICENSE", "START-HERE.md"])
  cpSync(join(root, file), join(bundle, file));
// Retain notices even when file tracing omits license-only files.
const licenses = join(bundle, "THIRD-PARTY-LICENSES");
mkdirSync(licenses);
function copyLicenses(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) copyLicenses(path);
    else if (
      /^(licen[sc]e|copying|copyright|notice)([.\-_]|$)/i.test(entry.name)
    ) {
      const dest = join(licenses, relative(join(root, "node_modules"), path));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(path, dest);
    }
  }
}
copyLicenses(join(root, "node_modules"));
writeFileSync(
  join(bundle, "THIRD-PARTY-NOTICES.txt"),
  "Vizor is rights reserved. Third-party software retains its own licenses.\nThis package includes Node.js and dependencies of Next.js, React, Prisma, better-sqlite3 and Argon2.\nSee runtime/LICENSE, THIRD-PARTY-LICENSES, and licenses within app/node_modules.\n",
);
writeFileSync(
  join(bundle, "Start Vizor.cmd"),
  '@echo off\r\nsetlocal\r\n"%~dp0runtime\\node.exe" "%~dp0portable-launch.mjs" %*\r\nif errorlevel 1 pause\r\n',
);
const shell =
  '#!/bin/sh\ncase "$0" in */*) vizor_dir=${0%/*} ;; *) vizor_dir=. ;; esac\ncd "$vizor_dir" || exit 1\nexec ./runtime/node ./portable-launch.mjs "$@"\n';
writeFileSync(join(bundle, "start-vizor.sh"), shell, { mode: 0o755 });
writeFileSync(
  join(bundle, "Start Vizor.command"),
  '#!/bin/sh\ncase "$0" in */*) vizor_dir=${0%/*} ;; *) vizor_dir=. ;; esac\ncd "$vizor_dir" || exit 1\n./runtime/node ./portable-launch.mjs "$@"\nresult=$?\nif [ "$result" -ne 0 ]; then printf "Press Enter to close."; read -r reply; fi\nexit "$result"\n',
  { mode: 0o755 },
);
const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
}).stdout.trim();
const manifest = {
  app: "vizor",
  version,
  platform: process.platform,
  arch: process.arch,
  moduleABI: "137",
  nodeVersion,
  nodeArchiveSHA256: expected,
  sourceCommit,
};
writeFileSync(
  join(bundle, "vizor-portable.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const secrets = [process.env.MASTER_KEY];
if (existsSync(join(root, ".env")))
  secrets.push(
    util.parseEnv(readFileSync(join(root, ".env"), "utf8")).MASTER_KEY,
  );
function scan(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Portable output contains a non-relocatable link.");
    if (entry.isDirectory()) scan(path);
    else {
      if (entry.name.startsWith(".env") || /\.db(?:-|$)/.test(entry.name))
        throw new Error("Private files were found in the portable output.");
      const content = readFileSync(path);
      if (secrets.some((secret) => secret && content.includes(secret)))
        throw new Error(
          "Build-time configuration was found in portable output; package creation stopped.",
        );
    }
  }
}
scan(bundle);
const output = join(
  artifacts,
  `${name}.${process.platform === "win32" ? "zip" : "tar.gz"}`,
);
if (existsSync(output))
  throw new Error(
    "This package already exists. Move the previous artifact before creating another.",
  );
if (process.platform === "win32") {
  // ZIP portable output; PowerShell's archive API preserves nested dotfiles.
  const script =
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:VIZOR_ARCHIVE_SOURCE, $env:VIZOR_ARCHIVE_OUTPUT, [System.IO.Compression.CompressionLevel]::Optimal, $true)";
  const result = spawnSync(
    join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: {
        ...process.env,
        VIZOR_ARCHIVE_SOURCE: bundle,
        VIZOR_ARCHIVE_OUTPUT: output,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result.status !== 0) throw new Error("ZIP creation failed.");
} else run("/usr/bin/tar", ["-czf", output, "-C", staging, name]);
const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
writeFileSync(`${output}.sha256`, `${sha256}  ${basename(output)}\n`);
writeFileSync(
  join(artifacts, "portable-result.json"),
  JSON.stringify(
    {
      ...manifest,
      archive: output,
      bundle,
      sha256,
      bytes: statSync(output).size,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    archive: output,
    sha256,
    bytes: statSync(output).size,
    target,
  }),
);
