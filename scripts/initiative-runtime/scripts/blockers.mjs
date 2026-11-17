import { randomUUID } from "node:crypto";
import {
  openCloudReturnStore,
  pendingCloudReturn,
  matchesCloudReturn,
  cloudReturnSnapshot,
} from "./cloud-return.mjs";
import { openLifecycleStore } from "./claude-lifecycle.mjs";

const lines = (text) => (text ?? "").split(/\r?\n/);
export function openBlockerStore(db) {
  openCloudReturnStore(db);
  openLifecycleStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS blocker_runs (
    id TEXT PRIMARY KEY, issue INTEGER NOT NULL, assignment TEXT NOT NULL,
    agent TEXT NOT NULL, comment TEXT NOT NULL, body TEXT NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    session TEXT, successor INTEGER, uncertain TEXT, decision TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    reported_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(issue, assignment)
  );
  CREATE TABLE IF NOT EXISTS blocker_activity (
    sequence INTEGER PRIMARY KEY, run TEXT NOT NULL, at TEXT NOT NULL,
    action TEXT NOT NULL, detail TEXT NOT NULL
  );`);
  if (
    !db
      .prepare("PRAGMA table_info(blocker_runs)")
      .all()
      .some((column) => column.name === "reported_at")
  )
    db.exec("ALTER TABLE blocker_runs ADD COLUMN reported_at TEXT");
}

export function activity(db, id, action, detail) {
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO blocker_activity(run,at,action,detail) VALUES (?,?,?,?)",
  ).run(id, at, action, detail);
  db.prepare("UPDATE blocker_runs SET updated_at=? WHERE id=?").run(at, id);
}

// The HMAC listener and authenticated GitHub reconciliation share this binding check.
export function recordBlocker({ db, config, issue, comment }) {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE name='scheduled_issues'")
      .get()
  )
    return false;
  const row = db
    .prepare(
      `SELECT s.*, a.comment AS link, d.state AS receipt
    FROM scheduled_issues s JOIN assignments a USING(issue)
    JOIN deliveries d USING(issue) WHERE s.issue=? AND s.agent=a.agent`,
    )
    .get(issue);
  const agent = row && config.agents[row.agent];
  const replacement =
    row &&
    db
      .prepare(
        `SELECT s.accepted,s.result FROM task_recoveries r
    JOIN scheduled_issues s ON s.issue=r.recheck WHERE r.issue=?`,
      )
      .get(issue);
  if (replacement?.accepted && replacement.result === "done") return false;
  if (
    row &&
    !matchesCloudReturn(pendingCloudReturn(db, issue, row.assignment), comment)
  )
    return false;
  if (
    !agent ||
    row.receipt !== "started" ||
    !Number.isSafeInteger(comment?.id) ||
    BigInt(comment.id) <= BigInt(row.assignment) ||
    row.link !==
      `https://github.com/${config.repository}/issues/${issue}#issuecomment-${row.assignment}` ||
    !agent.trustedManagers.some(
      (login) => login.toLowerCase() === comment.user?.login?.toLowerCase(),
    ) ||
    !lines(comment.body).includes("Vizor result: blocked")
  )
    return false;
  const kind = lines(comment.body).includes("Vizor blocker: capacity")
    ? "capacity"
    : lines(comment.body).includes("Vizor blocker: external")
      ? "external"
      : "ordinary";
  const id = randomUUID();
  const at = new Date().toISOString();
  const added = db
    .prepare(
      `INSERT OR IGNORE INTO blocker_runs
    (id,issue,assignment,agent,comment,body,kind,reported_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      issue,
      row.assignment,
      row.agent,
      String(comment.id),
      comment.body,
      kind,
      Number.isFinite(Date.parse(comment.created_at))
        ? comment.created_at
        : null,
      at,
      at,
    ).changes;
  if (added)
    activity(
      db,
      id,
      "blocked",
      `#${issue}: ${kind} blocker received; original worker ${row.agent}.`,
    );
  return Boolean(added);
}

export function blockerSnapshot(db) {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE name='blocker_runs'")
      .get()
  )
    return { investigations: [], activity: [], cloudReturns: [] };
  return {
    providerObservations: db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='provider_observations'",
      )
      .get()
      ? db
          .prepare(
            "SELECT issue,assignment,session,state,detail,observed_at,finished_at FROM provider_observations ORDER BY updated_at DESC",
          )
          .all()
      : [],
    cloudReturns: cloudReturnSnapshot(db),
    investigations: db
      .prepare(
        "SELECT id,issue,agent,kind,state,session,successor,decision,updated_at FROM blocker_runs ORDER BY created_at DESC",
      )
      .all(),
    activity: db
      .prepare(
        "SELECT a.*,r.issue FROM blocker_activity a JOIN blocker_runs r ON r.id=a.run ORDER BY sequence DESC LIMIT 100",
      )
      .all(),
  };
}
