import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors";
function master() {
  const raw = process.env.MASTER_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw)
    throw new AppError(
      "configuration",
      "Configure a permanent 32-byte MASTER_KEY before connecting a provider.",
      503,
    );
  return key;
}
export function encryptKey(value: string, owner: string, provider: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master(), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([owner, provider])));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}
export function decryptKey(value: string, owner: string, provider: string) {
  const key = master();
  try {
    const [version, iv, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(JSON.stringify([owner, provider])));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(
      "key_unavailable",
      "The saved key cannot be decrypted. Restore the original master key or reconnect Claude.",
      503,
    );
  }
}
