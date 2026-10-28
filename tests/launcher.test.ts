import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkNode,
  ensureConfig,
  validateConfig,
  localAddress,
  availablePort,
  databasePath,
  acquireLock,
  npmCommand,
} from "../scripts/local-runtime.mjs";
import { sourceFingerprint } from "../scripts/launch.mjs";
const folders: string[] = [];
function fresh() {
  const root = mkdtempSync(join(tmpdir(), "vizor launcher "));
  folders.push(root);
  return root;
}
afterAll(() => {
  for (const folder of folders) {
    if (
      !resolve(folder).startsWith(
        resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"),
      ) ||
      !folder.includes("vizor launcher ")
    )
      throw Error("Unexpected cleanup target");
    rmSync(folder, { recursive: true, force: true });
  }
});
describe("downloadable local setup", () => {
  it("accepts supported Node 24 and rejects incompatible majors and early versions", () => {
    expect(() => checkNode("24.11.0")).not.toThrow();
    expect(() => checkNode("24.22.1")).not.toThrow();
    for (const version of ["20.20.0", "22.20.0", "24.10.0", "26.0.0"])
      expect(() => checkNode(version)).toThrow("Node.js 24");
  });
  it("creates an independent permanent key for every download and preserves it on repeat setup", () => {
    const one = fresh(),
      two = fresh();
    const first = ensureConfig(one, {});
    const contents = readFileSync(join(one, ".env"), "utf8");
    expect(first.created).toBe(true);
    expect(first.config.MASTER_KEY).not.toBe(
      ensureConfig(two, {}).config.MASTER_KEY,
    );
    expect(ensureConfig(one, {}).config.MASTER_KEY).toBe(
      first.config.MASTER_KEY,
    );
    expect(readFileSync(join(one, ".env"), "utf8")).toBe(contents);
    expect(first.config).toMatchObject({
      SELF_HOST: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      CHECKPOINT_DISABLE: "1",
    });
  });
  it("refuses to generate replacement keys for existing data or an invalid existing .env", () => {
    const root = fresh();
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data/vizor.db"), "existing data");
    expect(() => ensureConfig(root, {})).toThrow("Existing data");
    expect(existsSync(join(root, ".env"))).toBe(false);
    writeFileSync(join(root, ".env"), 'MASTER_KEY="bad"\n');
    expect(() => ensureConfig(root, {})).toThrow("MASTER_KEY");
    expect(readFileSync(join(root, ".env"), "utf8")).toContain('"bad"');
  });
  it("handles quoted paths with spaces and custom loopback ports", () => {
    const root = fresh();
    const { config } = ensureConfig(root, {});
    const changed = {
      ...config,
      DATABASE_URL: "file:./my data/workspace.db",
      APP_ORIGIN: "http://127.0.0.1:3456",
    };
    expect(validateConfig(root, changed)).toBe(changed);
    expect(databasePath(root, changed.DATABASE_URL)).toBe(
      join(root, "my data", "workspace.db"),
    );
    expect(localAddress(changed)).toEqual({
      origin: "http://127.0.0.1:3456",
      port: 3456,
    });
  });
  it("rejects remote exposure, malformed origins and unsupported database URLs", () => {
    const root = fresh();
    const { config } = ensureConfig(root, {});
    expect(() =>
      validateConfig(root, { ...config, APP_ORIGIN: "http://0.0.0.0:3000" }),
    ).toThrow("this computer");
    expect(() =>
      validateConfig(root, {
        ...config,
        APP_ORIGIN: "http://127.0.0.1:3000/path",
      }),
    ).toThrow("without a path");
    expect(() => validateConfig(root, { ...config, SELF_HOST: "yes" })).toThrow(
      "SELF_HOST",
    );
    expect(() => databasePath(root, "postgresql://example.invalid/db")).toThrow(
      "SQLite",
    );
    expect(() =>
      localAddress({ ...config, APP_ORIGIN: "https://127.0.0.1:3000" }),
    ).toThrow("local launcher");
  });
  it("does not stop or alter an occupied port", async () => {
    const server = createServer();
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address() as { port: number };
    try {
      await expect(availablePort(address.port)).rejects.toThrow(
        "already in use",
      );
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it("prevents concurrent setup and removes only its own lock", () => {
    const root = fresh();
    const lock = acquireLock(root);
    expect(() => acquireLock(root)).toThrow("already running");
    lock.update({ serverPid: 123 });
    expect(
      JSON.parse(readFileSync(join(root, "data/.vizor-launch.lock"), "utf8"))
        .serverPid,
    ).toBe(123);
    lock.release();
    const next = acquireLock(root);
    lock.release();
    expect(existsSync(join(root, "data/.vizor-launch.lock"))).toBe(true);
    next.release();
  });
  it("uses controlled cross-platform npm commands without shell interpolation", () => {
    expect(npmCommand(["ci", "--no-audit"], "linux")).toEqual({
      command: "npm",
      args: ["ci", "--no-audit"],
    });
    expect(npmCommand(["run", "build"], "win32").args.at(-1)).toBe(
      "npm run build",
    );
    expect(() => npmCommand(["ci;echo secret"], "win32")).toThrow(
      "Unsupported",
    );
  });
  it("rebuilds when app source changes, without including user secrets or generated files in the fingerprint", () => {
    const root = fresh();
    mkdirSync(join(root, "src/generated"), { recursive: true });
    writeFileSync(join(root, "src/app.ts"), "version one");
    const first = sourceFingerprint(root);
    writeFileSync(join(root, ".env"), "private");
    writeFileSync(join(root, "src/generated/client.ts"), "generated");
    expect(sourceFingerprint(root)).toBe(first);
    writeFileSync(join(root, "src/app.ts"), "version two");
    expect(sourceFingerprint(root)).not.toBe(first);
  });
});
