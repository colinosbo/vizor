import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const projectContext = new AsyncLocalStorage();
export const currentProjectId = () => projectContext.getStore() ?? "default";
export const projectIdSchema = z.union([z.literal("default"), z.uuid()]);
export const scopePaths = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !/[\\:*?\0]/.test(path) &&
          path
            .split("/")
            .every(
              (part) =>
                part &&
                part !== "." &&
                part !== ".." &&
                part.toLowerCase() !== ".git",
            ),
      ),
  )
  .max(20)
  .refine(
    (paths) => new Set(paths).size === paths.length,
    "Use each approved file once.",
  );
export const projectDocument = z.strictObject({
  name: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(20000),
});
export const projectInput = z.strictObject({
  requestId: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  goal: z.string().trim().min(1).max(8000),
  repository: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .max(160),
  paths: scopePaths,
  agentIds: z.array(z.uuid()).min(1).max(32),
  managerId: z.uuid(),
  document: projectDocument.optional(),
});

export function projectStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shared_project (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL,
      repository TEXT NOT NULL, paths TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO shared_project (id, name, goal, repository, paths)
      VALUES ('default', 'BlackForge', '', 'crayosog-star/BlackforgeMC', '[]');
    CREATE TABLE IF NOT EXISTS project_dashboard (
      project_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (project_id, kind)
    );
    CREATE TABLE IF NOT EXISTS project_creation (
      request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(event)").all();
  if (
    !database
      .prepare("PRAGMA table_info(shared_project)")
      .all()
      .some((column) => column.name === "document")
  )
    database.exec("ALTER TABLE shared_project ADD COLUMN document TEXT");
  if (!columns.some((column) => column.name === "project_id"))
    database.exec(
      "ALTER TABLE event ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'",
    );
  database.exec(
    "CREATE INDEX IF NOT EXISTS event_project ON event(project_id)",
  );
  for (const [table, kind] of [
    ["dashboard_findings", "findings"],
    ["dashboard_repository", "repository"],
  ]) {
    const old = database
      .prepare(`SELECT body FROM ${table} WHERE id = 1`)
      .get();
    if (old)
      database
        .prepare(
          "INSERT OR IGNORE INTO project_dashboard (project_id, kind, body) VALUES ('default', ?, ?)",
        )
        .run(kind, old.body);
  }
  const parse = (row) =>
    row
      ? {
          ...row,
          paths: JSON.parse(row.paths),
          document: row.document ? JSON.parse(row.document) : null,
        }
      : null;
  return {
    get(id = currentProjectId()) {
      return parse(
        database.prepare("SELECT * FROM shared_project WHERE id = ?").get(id),
      );
    },
    list() {
      return database
        .prepare("SELECT * FROM shared_project ORDER BY created, rowid")
        .all()
        .map(parse);
    },
    create(input) {
      const id = randomUUID();
      database
        .prepare(
          "INSERT INTO shared_project (id, name, goal, repository, paths, document) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.name,
          input.goal,
          input.repository,
          JSON.stringify(input.paths),
          input.document ? JSON.stringify(input.document) : null,
        );
      return id;
    },
    saveDocument(document) {
      database
        .prepare("UPDATE shared_project SET document = ? WHERE id = ?")
        .run(JSON.stringify(document), currentProjectId());
    },
    updateScope(goal, paths) {
      database
        .prepare("UPDATE shared_project SET goal = ?, paths = ? WHERE id = ?")
        .run(goal, JSON.stringify(paths), currentProjectId());
    },
    creation(requestId) {
      return database
        .prepare(
          "SELECT project_id, body FROM project_creation WHERE request_id = ?",
        )
        .get(requestId);
    },
    saveCreation(requestId, projectId, body) {
      database
        .prepare(
          "INSERT INTO project_creation (request_id, project_id, body) VALUES (?, ?, ?)",
        )
        .run(requestId, projectId, body);
    },
    dashboard(kind) {
      return (
        database
          .prepare(
            "SELECT body FROM project_dashboard WHERE project_id = ? AND kind = ?",
          )
          .get(currentProjectId(), kind)?.body ?? null
      );
    },
    saveDashboard(kind, body) {
      database
        .prepare(
          "INSERT INTO project_dashboard (project_id, kind, body) VALUES (?, ?, ?) ON CONFLICT(project_id, kind) DO UPDATE SET body=excluded.body",
        )
        .run(currentProjectId(), kind, body);
    },
  };
}
