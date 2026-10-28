import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Build the Windows installer on Windows x64.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portable = JSON.parse(
  readFileSync(join(root, "artifacts/portable-result.json"), "utf8"),
);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const desktop = JSON.parse(
  readFileSync(join(root, "desktop/package.json"), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(join(portable.bundle, "vizor-portable.json"), "utf8"),
);
if (
  pkg.version !== desktop.version ||
  manifest.version !== pkg.version ||
  manifest.platform !== "win32"
)
  throw new Error(
    "Build the matching Windows portable package before creating the installer.",
  );
function run(script, args = [], env = process.env, cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Windows installer build failed.");
}
run(join(root, "scripts/build-icons.mjs"));
const builder = join(
  root,
  "desktop/node_modules/electron-builder/out/cli/cli.js",
);
if (!existsSync(builder))
  throw new Error("Run npm ci --prefix desktop before building the installer.");
run(
  builder,
  ["--win", "nsis", "--x64", "--config", "builder.cjs", "--publish", "never"],
  {
    ...process.env,
    VIZOR_INSTALLER_BUNDLE: portable.bundle,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
  join(root, "desktop"),
);
const installer = join(
  root,
  "artifacts/windows-installer",
  `Vizor-Setup-${pkg.version}-x64.exe`,
);
const sha256 = createHash("sha256")
  .update(readFileSync(installer))
  .digest("hex");
writeFileSync(`${installer}.sha256`, `${sha256}  ${basename(installer)}\n`);
writeFileSync(
  join(root, "artifacts/windows-result.json"),
  JSON.stringify(
    {
      version: pkg.version,
      sourceCommit: manifest.sourceCommit,
      installer,
      executable: join(dirname(installer), "win-unpacked/Vizor.exe"),
      sha256,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ installer, sha256 }));
