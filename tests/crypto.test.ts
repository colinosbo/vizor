import { describe, expect, it } from "vitest";
import { decryptKey, encryptKey } from "../src/lib/server/crypto";
describe("credential encryption", () => {
  it("round trips with a fresh nonce and no plaintext", () => {
    const secret = "sk-ant-fixture-not-a-real-key";
    const a = encryptKey(secret, "alice", "anthropic"),
      b = encryptKey(secret, "alice", "anthropic");
    expect(a).not.toEqual(b);
    expect(a).not.toContain(secret);
    expect(decryptKey(a, "alice", "anthropic")).toBe(secret);
  });
  it("rejects a different owner, provider, master key, or tampered payload", () => {
    const encrypted = encryptKey("secret", "alice", "anthropic");
    expect(() => decryptKey(encrypted, "bob", "anthropic")).toThrow();
    expect(() => decryptKey(encrypted, "alice", "openai")).toThrow();
    const parts = encrypted.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptKey(parts.join("."), "alice", "anthropic")).toThrow();
    const original = process.env.MASTER_KEY;
    process.env.MASTER_KEY = Buffer.alloc(32, 1).toString("base64");
    expect(() => decryptKey(encrypted, "alice", "anthropic")).toThrow();
    process.env.MASTER_KEY = original;
  });
  it("fails closed when the master key is absent or malformed", () => {
    const original = process.env.MASTER_KEY;
    for (const bad of ["", "small", "a".repeat(44)]) {
      process.env.MASTER_KEY = bad;
      expect(() => encryptKey("secret", "alice", "anthropic")).toThrow();
    }
    process.env.MASTER_KEY = original;
  });
});
