import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  acquireLease,
  leaseHolder,
  LeaseHeldError,
  LeaseLostError,
} from "../scripts/runner-lease.mjs";
import { openDispatchStore } from "../scripts/relay.mjs";
import { openSchedulerStore, runScheduler } from "../scripts/scheduler.mjs";

const base = { queue: "/p/.vizor/queue.json", executable: "/v1/vizor.mjs" };

test("a second runner cannot dispatch while the first is alive", () => {
  const db = new DatabaseSync(":memory:");
  const first = acquireLease(db, { ...base, pid: 100, alive: () => true });
  assert.throws(
    () => acquireLease(db, { ...base, pid: 200, alive: () => true }),
    LeaseHeldError,
  );
  assert.equal(leaseHolder(db).pid, 100);
  first.assert();
  first.release();
  assert.equal(leaseHolder(db), null);
  acquireLease(db, { ...base, pid: 200, alive: () => true });
  assert.equal(leaseHolder(db).pid, 200);
});

test("a dead holder on this host is taken over immediately and fenced out", () => {
  const db = new DatabaseSync(":memory:");
  const old = acquireLease(db, { ...base, pid: 100, host: "pc" });
  const next = acquireLease(db, {
    ...base,
    pid: 200,
    host: "pc",
    executable: "/v2/vizor.mjs",
    alive: (pid) => pid !== 100,
  });
  assert.equal(leaseHolder(db).executable, "/v2/vizor.mjs");
  // The old process, if it somehow resumed, may not dispatch.
  assert.throws(() => old.assert(), LeaseLostError);
  next.assert();
  // Releasing the stale handle never removes the new owner's lease.
  old.release();
  assert.equal(leaseHolder(db).pid, 200);
});

test("an expired heartbeat is taken over even when liveness is unknown", () => {
  const db = new DatabaseSync(":memory:");
  let t = 1000;
  acquireLease(db, { ...base, pid: 100, host: "a", now: () => t });
  t += 60000;
  assert.throws(
    () =>
      acquireLease(db, {
        ...base,
        pid: 200,
        host: "b",
        now: () => t,
        alive: () => true,
      }),
    LeaseHeldError,
  );
  t += 200000;
  acquireLease(db, { ...base, pid: 200, host: "b", now: () => t });
  assert.equal(leaseHolder(db).host, "b");
});

test("runScheduler refuses to start while another runner holds the queue", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vizor-lease-"));
  const file = join(directory, "queue.json");
  writeFileSync(file, JSON.stringify({ paused: false, issues: [] }));
  const db = openDispatchStore(new DatabaseSync(join(directory, "d.db")));
  // Close the database before deleting its folder (Windows locks open files).
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  openSchedulerStore(db);
  // Simulate a live runner: this test's parent process is certainly alive.
  acquireLease(db, { queue: file, executable: "other", pid: process.ppid });
  let dispatched = 0;
  await assert.rejects(
    runScheduler({
      db,
      file,
      once: true,
      config: { repository: "o/r", dispatchLabel: "d", agents: {} },
      github: () => assert.fail("must not touch GitHub"),
      dispatch: () => dispatched++,
    }),
    LeaseHeldError,
  );
  assert.equal(dispatched, 0);
  assert.equal(leaseHolder(db).pid, process.ppid);
});
