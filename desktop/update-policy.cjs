const { createPublicKey, verify } = require("node:crypto");
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function newer(version, current) {
  if (!stable.test(version) || !stable.test(current)) return false;
  const left = version.split(".").map(Number),
    right = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (!Number.isSafeInteger(left[i]) || !Number.isSafeInteger(right[i]))
      return false;
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}
function verifyManifest(info, bytes, signature, publicKey, current) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 65536 ||
    !newer(info.version, current)
  )
    throw new Error("Invalid update release");
  const sig = Buffer.from(String(signature).trim(), "base64");
  if (
    sig.length !== 64 ||
    !verify(
      null,
      bytes,
      createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        type: "spki",
        format: "der",
      }),
      sig,
    )
  )
    throw new Error("Update signature is invalid");
  const manifest = JSON.parse(bytes.toString("utf8"));
  const file = `Vizor-Setup-${info.version}-x64.exe`;
  if (
    manifest.schema !== 1 ||
    manifest.version !== info.version ||
    manifest.platform !== "win32" ||
    manifest.arch !== "x64" ||
    manifest.file !== file ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(manifest.sha512 || "") ||
    !Array.isArray(info.files) ||
    info.files.length !== 1
  )
    throw new Error("Update manifest does not match this app");
  const metadata = info.files[0];
  const expectedURL = `https://github.com/colinosbo/vizor/releases/download/v${info.version}/${file}`;
  if (
    ![file, expectedURL].includes(metadata.url) ||
    metadata.sha512 !== manifest.sha512 ||
    metadata.size !== manifest.size
  )
    throw new Error("Update download metadata is not authenticated");
  return manifest;
}
module.exports = { newer, verifyManifest };
