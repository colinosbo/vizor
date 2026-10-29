import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
const executable = join(dirname(installer), "win-unpacked/Vizor.exe");
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const { NtExecutable, NtExecutableResource, Resource } =
  requireDesktop("resedit");
const ico = readFileSync(join(root, "desktop/icon.ico"));
const expectedIcons = Array.from(
  { length: ico.readUInt16LE(4) },
  (_, index) => {
    const at = 6 + index * 16;
    return ico.subarray(
      ico.readUInt32LE(at + 12),
      ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8),
    );
  },
);
for (const file of [executable, installer]) {
  const resources = NtExecutableResource.from(
    NtExecutable.from(readFileSync(file)),
  );
  const matches = Resource.IconGroupEntry.fromEntries(resources.entries).some(
    (group) => {
      const icons = group.getIconItemsFromEntries(resources.entries);
      return expectedIcons.every((expected) =>
        icons.some(
          (icon) => icon.isRaw() && Buffer.from(icon.bin).equals(expected),
        ),
      );
    },
  );
  if (!matches)
    throw new Error(
      "The compiled Windows application or installer is missing the approved icon.",
    );
}
const packedIcon = requireDesktop("@electron/asar").extractFile(
  join(dirname(installer), "win-unpacked/resources/app.asar"),
  "icon.png",
);
if (
  !Buffer.from(packedIcon).equals(readFileSync(join(root, "desktop/icon.png")))
)
  throw new Error("The app window does not contain the approved icon.");
for (const file of [
  "main.cjs",
  "startup.cjs",
  "terminals.cjs",
  "preload.cjs",
  "updater.cjs",
  "update-policy.cjs",
  "update-source.cjs",
  "update-key.cjs",
]) {
  const packed = requireDesktop("@electron/asar").extractFile(
    join(dirname(installer), "win-unpacked/resources/app.asar"),
    file,
  );
  if (!Buffer.from(packed).equals(readFileSync(join(root, "desktop", file))))
    throw new Error(
      "The packaged update code does not match the production source.",
    );
}
for (const file of ["index.html", "intro.css", "intro.js"]) {
  const packed = join(dirname(installer), "win-unpacked/resources/intro", file);
  if (
    !readFileSync(packed).equals(readFileSync(join(root, "public/intro", file)))
  )
    throw new Error(
      "The packaged opening animation does not match the source.",
    );
}
const feed = requireDesktop("js-yaml").load(
  readFileSync(
    join(dirname(installer), "win-unpacked/resources/app-update.yml"),
    "utf8",
  ),
);
if (
  feed.provider !== "github" ||
  feed.owner !== "colinosbo" ||
  feed.repo !== "vizor" ||
  feed.private !== false ||
  feed.publisherName
)
  throw new Error(
    "The packaged public update feed is not configured correctly.",
  );
const sha256 = createHash("sha256")
  .update(readFileSync(installer))
  .digest("hex");
for (const file of [
  "host.cjs",
  "sessions.cjs",
  "tools.cjs",
  "isolated-pty.cjs",
  "pty-worker.cjs",
]) {
  const packed = join(
    dirname(installer),
    "win-unpacked/resources/vizor/terminal-host",
    file,
  );
  if (
    !readFileSync(packed).equals(
      readFileSync(join(root, "desktop/terminal-host", file)),
    )
  )
    throw new Error(
      "The packaged terminal helper does not match the tested source.",
    );
}
const nativeTerminal = spawnSync(
  join(dirname(installer), "win-unpacked/resources/vizor/runtime/node.exe"),
  [
    "-e",
    "require(process.argv[1])",
    join(
      dirname(installer),
      "win-unpacked/resources/vizor/terminal-host/node_modules/node-pty",
    ),
  ],
  { windowsHide: true, stdio: "ignore" },
);
if (nativeTerminal.status !== 0)
  throw new Error(
    "The packaged native terminal dependency cannot load in the bundled Node runtime.",
  );
writeFileSync(`${installer}.sha256`, `${sha256}  ${basename(installer)}\n`);
writeFileSync(
  join(root, "artifacts/windows-result.json"),
  JSON.stringify(
    {
      version: pkg.version,
      sourceCommit: manifest.sourceCommit,
      installer,
      executable,
      iconResourcesVerified: true,
      updateResourcesVerified: true,
      terminalResourcesVerified: true,
      iconSourceSHA256: createHash("sha256")
        .update(readFileSync(join(root, "desktop/clawd-scope.png")))
        .digest("hex"),
      sha256,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ installer, sha256 }));
