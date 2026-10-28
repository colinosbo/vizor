import { expect, it, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { verifyManifest, newer } = require("../desktop/update-policy.cjs");
const { UpdateManager } = require("../desktop/updater.cjs");
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (
      !resolve(folder).startsWith(join(resolve(tmpdir()), "vizor-update-unit-"))
    )
      throw new Error(
        "Refusing to remove a directory outside the update fixtures",
      );
    rmSync(folder, { recursive: true, force: true });
  }
});
function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const sha512 = createHash("sha512")
    .update("installer fixture")
    .digest("base64");
  const manifest = {
    schema: 1,
    version: "0.8.1",
    platform: "win32",
    arch: "x64",
    file: "Vizor-Setup-0.8.1-x64.exe",
    size: 17,
    sha512,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = sign(null, bytes, privateKey).toString("base64");
  const info = {
    version: "0.8.1",
    files: [{ url: manifest.file, size: 17, sha512 }],
  };
  return { privateKey, pub, manifest, bytes, signature, info };
}
it("authenticates the exact installer version, URL, size and checksum", () => {
  const f = fixture();
  expect(verifyManifest(f.info, f.bytes, f.signature, f.pub, "0.8.0")).toEqual(
    f.manifest,
  );
  const absolute = structuredClone(f.info);
  absolute.files[0].url =
    "https://github.com/colinosbo/vizor/releases/download/v0.8.1/Vizor-Setup-0.8.1-x64.exe";
  expect(
    verifyManifest(absolute, f.bytes, f.signature, f.pub, "0.8.0"),
  ).toEqual(f.manifest);
});
it("rejects corrupted signatures, changed signed data and a different signer", () => {
  const f = fixture();
  for (const [bytes, signature, pub] of [
    [f.bytes, Buffer.alloc(64).toString("base64"), f.pub],
    [
      Buffer.from(f.bytes.toString().replace("0.8.1", "0.9.0")),
      f.signature,
      f.pub,
    ],
    [f.bytes, f.signature, fixture().pub],
  ] as const)
    expect(() =>
      verifyManifest(f.info, bytes, signature, pub, "0.8.0"),
    ).toThrow();
});
it("rejects an untrusted download URL, hash, size or extra executable", () => {
  const f = fixture();
  for (const mutate of [
    (info: typeof f.info) => {
      info.files[0].url = "https://evil.invalid/update.exe";
    },
    (info: typeof f.info) => {
      info.files[0].url = "../update.exe";
    },
    (info: typeof f.info) => {
      info.files[0].sha512 = createHash("sha512")
        .update("tampered")
        .digest("base64");
    },
    (info: typeof f.info) => {
      info.files[0].size++;
    },
    (info: typeof f.info) => {
      info.files.push(info.files[0]);
    },
    (info: typeof f.info) => {
      Object.assign(info, {
        packages: { x64: { path: "https://evil.invalid/extra-package.7z" } },
      });
    },
  ]) {
    const info = structuredClone(f.info);
    mutate(info);
    expect(() =>
      verifyManifest(info, f.bytes, f.signature, f.pub, "0.8.0"),
    ).toThrow();
  }
});
it("rejects wrong-platform signed manifests and oversized verification data", () => {
  const f = fixture();
  const bytes = Buffer.from(JSON.stringify({ ...f.manifest, arch: "arm64" }));
  expect(() =>
    verifyManifest(
      f.info,
      bytes,
      sign(null, bytes, f.privateKey).toString("base64"),
      f.pub,
      "0.8.0",
    ),
  ).toThrow();
  expect(() =>
    verifyManifest(f.info, Buffer.alloc(65537), f.signature, f.pub, "0.8.0"),
  ).toThrow();
});
it("never treats an older, same, prerelease or invalid version as a stable update", () => {
  expect(newer("0.10.0", "0.9.9")).toBe(true);
  for (const version of [
    "0.8.0",
    "0.7.9",
    "0.9.0-beta.1",
    "../0.9.0",
    "00.9.0",
    "999999999999999999999.1.1",
  ])
    expect(newer(version, "0.8.0")).toBe(false);
});
function manager(options: Record<string, unknown> = {}) {
  const f = fixture();
  const home = mkdtempSync(join(tmpdir(), "vizor-update-unit-"));
  folders.push(home);
  class FakeUpdater extends EventEmitter {
    autoInstallOnAppQuit = false;
    checkForUpdates = vi.fn(async () => ({ updateInfo: f.info }));
    downloadUpdate = vi.fn(async () => {
      this.emit("download-progress", { percent: 51.4 });
      this.emit("update-downloaded");
      return [];
    });
    quitAndInstall = vi.fn();
  }
  const updater = new FakeUpdater();
  const publish = vi.fn();
  const activity = vi.fn(async () => 0);
  const stopBackend = vi.fn(async () => {});
  const source = {
    publicKey: f.pub,
    readAsset: vi.fn(async (_version: string, name: string) =>
      name.endsWith(".json") ? f.bytes : Buffer.from(f.signature),
    ),
  };
  const instance = new UpdateManager({
    updater,
    source,
    currentVersion: "0.8.0",
    home,
    publish,
    activity,
    stopBackend,
    makeToken: () => ({ cancel: vi.fn() }),
    ...options,
  });
  return {
    ...f,
    home,
    instance,
    updater,
    source,
    publish,
    activity,
    stopBackend,
  };
}
it("downloads only after successful authentication and stages installation for normal app quit", async () => {
  const f = manager();
  await f.instance.check();
  expect(f.source.readAsset).toHaveBeenCalledTimes(2);
  expect(f.updater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(f.instance.snapshot().state).toBe("ready");
  expect(f.updater.autoInstallOnAppQuit).toBe(true);
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
});
it("does not download or install a release with an invalid signature", async () => {
  const f = manager();
  f.source.readAsset.mockImplementation(
    async (_version: string, name: string) =>
      name.endsWith(".json") ? f.bytes : Buffer.from("untrusted"),
  );
  await f.instance.check();
  expect(f.instance.snapshot().state).toBe("error");
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
});
it("keeps offline/provider errors sanitized and leaves the app usable", async () => {
  const f = manager();
  f.updater.checkForUpdates.mockRejectedValueOnce(
    new Error("sensitive error text"),
  );
  await f.instance.check();
  expect(f.instance.snapshot().state).toBe("error");
  expect(JSON.stringify(f.instance.snapshot())).not.toContain(
    "sensitive error text",
  );
  await f.instance.check();
  expect(f.instance.snapshot().state).toBe("ready");
});
it("persists an opt-out, makes no automatic request when disabled and prevents install on quit", async () => {
  const f = manager();
  await f.instance.automatic(false);
  f.instance.dispose();
  const restored = new UpdateManager({
    updater: f.updater,
    source: f.source,
    currentVersion: "0.8.0",
    home: f.home,
    publish: f.publish,
    activity: f.activity,
    stopBackend: f.stopBackend,
    makeToken: () => ({ cancel() {} }),
  });
  expect(restored.snapshot().automatic).toBe(false);
  expect(f.updater.autoInstallOnAppQuit).toBe(false);
  expect(f.updater.downloadUpdate).not.toHaveBeenCalled();
  restored.dispose();
});
it("does not start a second check/download while another one is in progress", async () => {
  const f = manager();
  const first = f.instance.check();
  await f.instance.check();
  await first;
  expect(f.updater.checkForUpdates).toHaveBeenCalledTimes(1);
});
it("defers a requested restart while any generation is active or its status is unknown", async () => {
  const f = manager();
  await f.instance.check();
  for (const value of [1, null]) {
    f.activity.mockResolvedValueOnce(value as number);
    expect(await f.instance.restart()).toEqual({ ok: false, reason: "busy" });
  }
  expect(f.stopBackend).not.toHaveBeenCalled();
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
});
it("stops the owned server before handing the verified update to the installer", async () => {
  const f = manager();
  await f.instance.check();
  expect(await f.instance.restart()).toEqual({ ok: true });
  expect(f.stopBackend).toHaveBeenCalledTimes(1);
  expect(f.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(f.stopBackend.mock.invocationCallOrder[0]).toBeLessThan(
    f.updater.quitAndInstall.mock.invocationCallOrder[0],
  );
});
