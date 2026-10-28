import Database from "better-sqlite3";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  cpSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { migrate } from "../scripts/portable-migrate.mjs";
const folders: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vizor portable migration "));
  folders.push(root);
  const migrations = join(root, "migrations");
  cpSync(resolve("prisma/migrations"), migrations, { recursive: true });
  return { database: join(root, "data/vizor.db"), migrations, Database };
}
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
it("creates a fresh database with Prisma-compatible migration history and is repeatable", async () => {
  const options = fixture();
  expect((await migrate(options)).applied).toBe(3);
  expect(await migrate(options)).toEqual({ applied: 0, backup: undefined });
  const db = new Database(options.database);
  try {
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND applied_steps_count = 1',
        )
        .get(),
    ).toEqual({ n: 3 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM User").get()).toEqual({
      n: 0,
    });
  } finally {
    db.close();
  }
});
it("preserves populated Prisma-created history, Windows checksums, foreign keys and ciphertext through upgrades", async () => {
  const options = fixture();
  const files = readdirSync(options.migrations)
    .filter((name) => /^\d/.test(name))
    .sort();
  const later = files.slice(1).map((name) => ({
    name,
    sql: readFileSync(join(options.migrations, name, "migration.sql")),
  }));
  for (const { name } of later)
    rmSync(join(options.migrations, name), { recursive: true });
  await migrate(options);
  let db = new Database(options.database);
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO User(id,email,passwordHash) VALUES('u','test@local.invalid','keep-hash')",
  ).run();
  db.prepare(
    "INSERT INTO Agent(id,userId,name,model,systemPrompt) VALUES('a','u','Keep name','claude-sonnet-4-6','Keep prompt')",
  ).run();
  db.prepare("INSERT INTO Conversation(id,agentId) VALUES('c','a')").run();
  db.prepare(
    "INSERT INTO Message(id,conversationId,position,role,text) VALUES('m','c',0,'user','Keep message')",
  ).run();
  db.prepare(
    "INSERT INTO Credential(id,userId,provider,encrypted,last4,updatedAt) VALUES('k','u','anthropic','ciphertext-to-preserve','erve',CURRENT_TIMESTAMP)",
  ).run();
  const first = readFileSync(
    join(options.migrations, files[0], "migration.sql"),
    "utf8",
  ).replace(/\r?\n/g, "\r\n");
  db.prepare('UPDATE "_prisma_migrations" SET checksum = ?').run(
    createHash("sha256").update(first).digest("hex"),
  );
  db.close();
  for (const { name, sql } of later) {
    mkdirSync(join(options.migrations, name));
    writeFileSync(join(options.migrations, name, "migration.sql"), sql);
  }
  const result = await migrate(options);
  expect(result.applied).toBe(2);
  expect(result.backup).toBeTruthy();
  db = new Database(options.database);
  try {
    expect(db.prepare("SELECT text FROM Message").get()).toEqual({
      text: "Keep message",
    });
    expect(db.prepare("SELECT encrypted FROM Credential").get()).toEqual({
      encrypted: "ciphertext-to-preserve",
    });
    expect(db.prepare("SELECT name FROM Agent").get()).toEqual({
      name: "Keep name",
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
  }
});
it("blocks tampered migrations and downgrades without modifying saved rows", async () => {
  const options = fixture();
  await migrate(options);
  const db = new Database(options.database);
  db.prepare(
    'UPDATE "_prisma_migrations" SET checksum = ? WHERE rowid = 1',
  ).run("0".repeat(64));
  db.close();
  await expect(migrate(options)).rejects.toThrow("checksums");
  const another = fixture();
  await migrate(another);
  const other = new Database(another.database);
  other
    .prepare(
      'UPDATE "_prisma_migrations" SET migration_name = ? WHERE rowid = 1',
    )
    .run("999999_future");
  other.close();
  await expect(migrate(another)).rejects.toThrow("newer version");
});
it("rolls back failed SQL, records the failure and blocks unsafe retries", async () => {
  const options = fixture();
  await migrate(options);
  const extra = join(options.migrations, "999999_failed");
  mkdirSync(extra);
  writeFileSync(
    join(extra, "migration.sql"),
    "CREATE TABLE MustRollBack(id TEXT); INSERT INTO MissingTable VALUES(1);",
  );
  await expect(migrate(options)).rejects.toThrow("rolled back");
  const db = new Database(options.database);
  try {
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='MustRollBack'")
        .get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
  await expect(migrate(options)).rejects.toThrow("did not finish");
});
it("refuses to reinterpret an existing database without migration history", async () => {
  const options = fixture();
  mkdirSync(join(options.database, ".."), { recursive: true });
  const db = new Database(options.database);
  db.exec("CREATE TABLE PrivateData(id TEXT)");
  db.close();
  await expect(migrate(options)).rejects.toThrow(
    "no recognized migration history",
  );
});
