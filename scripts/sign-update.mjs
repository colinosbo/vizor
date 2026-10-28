import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
const root = process.cwd();
const requireDesktop = createRequire(join(root, "desktop/package.json"));
const result = JSON.parse(
  readFileSync("artifacts/windows-result.json", "utf8"),
);
const check = JSON.parse(
  readFileSync("artifacts/windows-smoke-result.json", "utf8"),
);
if (!check.passed || check.installerSHA256 !== result.sha256)
  throw new Error(
    "Only the tested Windows installer may be signed for updates.",
  );
const encoded = process.env.VIZOR_UPDATE_SIGNING_KEY;
if (!encoded)
  throw new Error(
    "The permanent release signing key is required. Configure the repository signing secret; do not generate a replacement during a build.",
  );
const privateKey = createPrivateKey({
  key: Buffer.from(encoded, "base64"),
  type: "pkcs8",
  format: "der",
});
if (
  createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64") !== requireDesktop("./update-key.cjs")
)
  throw new Error(
    "The signing key does not match the app's pinned release identity.",
  );
const installer = readFileSync(result.installer);
const sha512 = createHash("sha512").update(installer).digest("base64");
if (createHash("sha256").update(installer).digest("hex") !== result.sha256)
  throw new Error("The tested installer changed before signing.");
const filename = `Vizor-Setup-${result.version}-x64.exe`;
const info = requireDesktop("js-yaml").load(
  readFileSync(join(dirname(result.installer), "latest.yml"), "utf8"),
);
if (
  info.version !== result.version ||
  info.files?.length !== 1 ||
  info.files[0].url !== filename ||
  info.files[0].size !== installer.length ||
  info.files[0].sha512 !== sha512
)
  throw new Error("The updater metadata does not match the tested installer.");
const bytes = Buffer.from(
  JSON.stringify({
    schema: 1,
    version: result.version,
    platform: "win32",
    arch: "x64",
    file: filename,
    size: installer.length,
    sha512,
  }) + "\n",
);
writeFileSync(join(dirname(result.installer), "vizor-update.json"), bytes);
writeFileSync(
  join(dirname(result.installer), "vizor-update.sig"),
  sign(null, bytes, privateKey).toString("base64") + "\n",
);
console.log("Authenticated update manifest created for the tested installer.");
