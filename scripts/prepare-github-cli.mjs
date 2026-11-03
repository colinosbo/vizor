import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Prepare GitHub CLI on Windows x64.");
const version = "2.103.3";
const archiveHash =
  "98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0";
const executableHash =
  "d303d8ac3f5e9438bf7c977b64dd6425513eae46218f8881d30694f28c1d0dfd";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const folder = resolve("artifacts/github-cli"),
  archive = join(folder, `gh_${version}_windows_amd64.zip`),
  executable = join(folder, "gh.exe"),
  license = join(folder, "LICENSE");
mkdirSync(folder, { recursive: true });
if (
  !existsSync(executable) ||
  hash(readFileSync(executable)) !== executableHash ||
  !existsSync(license)
) {
  let bytes;
  const existing = resolve(
    `artifacts/release-tools/gh_${version}_windows_amd64.zip`,
  );
  if (existsSync(existing) && hash(readFileSync(existing)) === archiveHash)
    bytes = readFileSync(existing);
  else {
    const response = await fetch(
      `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_windows_amd64.zip`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok)
      throw Error(`GitHub CLI download failed (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (hash(bytes) !== archiveHash)
    throw Error("GitHub CLI archive checksum did not match.");
  writeFileSync(archive, bytes);
  const tar = join(process.env.SystemRoot, "System32/tar.exe");
  function extract(entry, maxBuffer) {
    const result = spawnSync(tar, ["-xOf", archive, entry], {
      windowsHide: true,
      maxBuffer,
    });
    if (result.status !== 0 || !result.stdout?.length)
      throw Error("GitHub CLI archive extraction failed.");
    return result.stdout;
  }
  const binary = extract("bin/gh.exe", 80 * 1024 * 1024);
  if (hash(binary) !== executableHash)
    throw Error("GitHub CLI executable checksum did not match.");
  writeFileSync(executable, binary);
  writeFileSync(license, extract("LICENSE", 1024 * 1024));
}
console.log(`Verified official GitHub CLI ${version}.`);
