import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const result = JSON.parse(
  readFileSync("artifacts/windows-result.json", "utf8"),
);
const check = JSON.parse(
  readFileSync("artifacts/windows-smoke-result.json", "utf8"),
);
const realUpdate = JSON.parse(
  readFileSync("artifacts/real-update-smoke-result.json", "utf8"),
);
const id = process.env.VIZOR_RELEASE_ID;
const terminals = JSON.parse(
  readFileSync("artifacts/terminal-smoke-result.json", "utf8"),
);
if (
  !/^\d+$/.test(id ?? "") ||
  process.env.GITHUB_REPOSITORY !== "colinosbo/vizor" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  !process.env.GITHUB_TOKEN
)
  throw new Error(
    "Installer uploads require the trusted manual main-branch workflow.",
  );
const digest = createHash("sha256")
  .update(readFileSync(result.installer))
  .digest("hex");
const requireDesktop = createRequire(
  join(process.cwd(), "desktop/package.json"),
);
const updateInfo = requireDesktop("js-yaml").load(
  readFileSync(join(dirname(result.installer), "latest.yml"), "utf8"),
);
requireDesktop("./update-policy.cjs").verifyManifest(
  updateInfo,
  readFileSync(join(dirname(result.installer), "vizor-update.json")),
  readFileSync(join(dirname(result.installer), "vizor-update.sig"), "utf8"),
  requireDesktop("./update-key.cjs"),
  "0.0.0",
);
if (
  !check.passed ||
  !terminals.passed ||
  !terminals.realConpty ||
  !terminals.bundledNode ||
  !terminals.noNodeOnPath ||
  !terminals.ownedCleanup ||
  terminals.sourceCommit !== result.sourceCommit ||
  !result.terminalResourcesVerified ||
  !check.install ||
  !check.desktopShortcut ||
  !check.upgradePersistence ||
  !check.uninstallPreservesData ||
  !realUpdate.passed ||
  !realUpdate.installOnNormalQuit ||
  !realUpdate.dataPreserved ||
  realUpdate.sourceCommit !== result.sourceCommit ||
  check.installerSHA256 !== digest ||
  result.sourceCommit !== process.env.VIZOR_RELEASE_COMMIT
)
  throw new Error(
    "The installer has not passed verification for this exact build.",
  );
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "Vizor-Windows-release",
};
const response = await fetch(
  `https://api.github.com/repos/colinosbo/vizor/releases/${id}`,
  { headers },
);
if (!response.ok)
  throw new Error(`Release lookup failed (${response.status}).`);
const release = await response.json();
if (
  !release.draft ||
  release.tag_name !== `v${result.version}` ||
  release.target_commitish !== result.sourceCommit
)
  throw new Error(
    "Uploads require the matching draft release and source commit.",
  );
for (const file of [
  result.installer,
  `${result.installer}.sha256`,
  `${result.installer}.blockmap`,
  ...["latest.yml", "vizor-update.json", "vizor-update.sig"].map((name) =>
    join(dirname(result.installer), name),
  ),
]) {
  const name = basename(file);
  const upload = await fetch(
    `https://uploads.github.com/repos/colinosbo/vizor/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: readFileSync(file),
    },
  );
  if (!upload.ok)
    throw new Error(`Installer upload failed (${upload.status}).`);
  console.log(`Uploaded verified ${name} to the draft release.`);
}
