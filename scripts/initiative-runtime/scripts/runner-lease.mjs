import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

// One scheduler may dispatch a project's queue at a time. The lease lives in the
// project's dispatch database, so every runner start (scheduled task, manual
// `schedule`, upgrade, restart) competes for the same row regardless of which
// installed runtime version started it.
export const LEASE_TTL_MS = 180000; // four missed 45-second rounds

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

export function openLeaseStore(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS runner_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, queue TEXT NOT NULL, executable TEXT NOT NULL, acquired_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL)",
  );
  return db;
}

export class LeaseHeldError extends Error {
  constructor(holder) {
    super(
      "Another Vizor runner owns this project's queue (pid " +
        holder.pid +
        " on " +
        holder.host +
        ", " +
        holder.executable +
        "). Not dispatching. Stop it with `vizor stop` or wait for it to exit.",
    );
    this.holder = holder;
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super(
      "This runner no longer owns the queue lease; another runner took over. Stopping without dispatching.",
    );
  }
}

// Acquire or take over the lease. Takeover is allowed only when the holder is
// provably gone: same host and its pid is dead, or its heartbeat expired.
export function acquireLease(
  db,
  {
    queue,
    executable,
    pid = process.pid,
    host = hostname(),
    now = Date.now,
    alive = processAlive,
    ttl = LEASE_TTL_MS,
  },
) {
  openLeaseStore(db);
  const owner = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    const holder = db.prepare("SELECT * FROM runner_lease WHERE id = 1").get();
    const t = now();
    const gone =
      !holder ||
      t - holder.renewed_at > ttl ||
      (holder.host === host && holder.pid !== pid && !alive(holder.pid));
    if (!gone) throw new LeaseHeldError(holder);
    db.prepare(
      "INSERT INTO runner_lease VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, pid=excluded.pid, host=excluded.host, queue=excluded.queue, executable=excluded.executable, acquired_at=excluded.acquired_at, renewed_at=excluded.renewed_at",
    ).run(owner, pid, host, queue, executable, t, t);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    owner,
    // Renew and fence: throws if another runner took the lease.
    assert() {
      const changed = db
        .prepare(
          "UPDATE runner_lease SET renewed_at = ? WHERE id = 1 AND owner = ?",
        )
        .run(now(), owner).changes;
      if (!changed) throw new LeaseLostError();
    },
    release() {
      try {
        db.prepare("DELETE FROM runner_lease WHERE id = 1 AND owner = ?").run(
          owner,
        );
      } catch {
        // The database may already be closed during shutdown; expiry covers it.
      }
    },
  };
}

export function leaseHolder(db) {
  openLeaseStore(db);
  return db.prepare("SELECT * FROM runner_lease WHERE id = 1").get() ?? null;
}
