// Runtime migrations without npm, Prisma CLI, or generated code on the user's PC.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

/** @param {string} sql */
function checksums(sql) {
  const lf = sql.replace(/\r\n/g, "\n");
  return [sql, lf, lf.replace(/\n/g, "\r\n")].map((text) =>
    createHash("sha256").update(text).digest("hex"),
  );
}

/** @param {{ database: string, migrations: string, Database: any }} options */
export async function migrate({ database, migrations, Database }) {
  mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
  const db = new Database(database);
  try {
    db.pragma("busy_timeout = 5000");
    const files = readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        sql: readFileSync(
          join(migrations, entry.name, "migration.sql"),
          "utf8",
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length)
      throw new Error(
        "This download is missing its database migrations. Extract the whole archive again.",
      );
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    if (
      tables.length &&
      !tables.some((table) => table.name === "_prisma_migrations")
    )
      throw new Error(
        "Existing database has no recognized migration history. Restore a complete Vizor backup; no tables were changed.",
      );
    db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL,
      "finished_at" DATETIME, "migration_name" TEXT NOT NULL, "logs" TEXT,
      "rolled_back_at" DATETIME, "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    const history = db
      .prepare(
        'SELECT * FROM "_prisma_migrations" WHERE rolled_back_at IS NULL',
      )
      .all();
    for (const row of history) {
      const file = files.find((entry) => entry.name === row.migration_name);
      if (!row.finished_at)
        throw new Error(
          "A previous database migration did not finish. Restore the pre-update backup before continuing.",
        );
      if (!file)
        throw new Error(
          "This database belongs to a newer version of Vizor. Download that version or newer; downgrading is blocked.",
        );
      if (!checksums(file.sql).includes(row.checksum))
        throw new Error(
          "Database migration checksums do not match this download. Restore the original files; the database was not upgraded.",
        );
    }
    const pending = files.filter(
      (file) => !history.some((row) => row.migration_name === file.name),
    );
    let backup;
    if (
      pending.length &&
      tables.some((table) => table.name !== "_prisma_migrations")
    ) {
      const folder = join(dirname(database), "backups");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      backup = join(
        folder,
        `pre-portable-upgrade-${Date.now()}-${randomUUID()}.db`,
      );
      await db.backup(backup);
    }
    for (const file of pending) {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at) VALUES (?, ?, ?, ?)',
      ).run(id, checksums(file.sql)[0], file.name, new Date().toISOString());
      // Table-rebuild migrations must disable FKs before BEGIN, never inside it.
      db.pragma("foreign_keys = OFF");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(file.sql);
        if (db.pragma("foreign_key_check").length)
          throw new Error("Foreign key validation failed");
        db.prepare(
          'UPDATE "_prisma_migrations" SET finished_at = ?, applied_steps_count = 1 WHERE id = ?',
        ).run(new Date().toISOString(), id);
        db.exec("COMMIT");
      } catch {
        if (db.inTransaction) db.exec("ROLLBACK");
        db.prepare('UPDATE "_prisma_migrations" SET logs = ? WHERE id = ?').run(
          "Migration failed; transaction rolled back. Restore the pre-update backup.",
          id,
        );
        throw new Error(
          "The database update failed and was rolled back. Restore the pre-update backup before retrying.",
        );
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
    return { applied: pending.length, backup };
  } finally {
    db.close();
  }
}
