import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  atomicJson,
  snapshotPath,
  validArtifactEvidence,
  logLine,
  readRuntimeSnapshot,
} from "./runtime-snapshot.mjs";
import { blockerSnapshot } from "./blockers.mjs";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { openRecoveryStore, recoverBlockedTasks } from "./recovery.mjs";
import { openBlockerStore, recordBlocker } from "./blockers.mjs";
import { orchestratorTick } from "./orchestrator.mjs";
import {
  pendingCloudReturn,
  matchesCloudReturn,
  finishCloudReturn,
} from "./cloud-return.mjs";
import { advanceCloudRechecks } from "./cloud-recheck.mjs";
import { acquireLease, LeaseLostError } from "./runner-lease.mjs";
import {
  planAssignmentAllowed,
  publishApprovedPhases,
} from "./phase-publisher.mjs";

const number = (value) => Number.isSafeInteger(value) && value > 0;
const fail = (message) => {
  throw Error(message);
};
const lines = (body) => (body ?? "").split(/\r?\n/);
const marker = /^Vizor result: (done|blocked)(?: \(PR #([1-9]\d*)\))?$/;

export function readQueue(file) {
  const queue = JSON.parse(readFileSync(file, "utf8"));
  if (
    !queue ||
    !Array.isArray(queue.issues) ||
    !queue.issues.every(number) ||
    new Set(queue.issues).size !== queue.issues.length ||
    typeof queue.paused !== "boolean" ||
    (queue.autoAcceptReviews !== undefined &&
      typeof queue.autoAcceptReviews !== "boolean") ||
    (queue.manualReviewIssues !== undefined &&
      (!Array.isArray(queue.manualReviewIssues) ||
        !queue.manualReviewIssues.every(
          (issue) => number(issue) && queue.issues.includes(issue),
        ))) ||
    (queue.dispatchMode !== undefined &&
      !["webhook", "local"].includes(queue.dispatchMode)) ||
    (queue.blockerOrchestrator !== undefined &&
      typeof queue.blockerOrchestrator !== "boolean") ||
    (queue.planFile !== undefined && typeof queue.planFile !== "string")
  ) {
    fail(
      "Invalid queue issues, pause setting, automatic review setting or dispatch mode.",
    );
  }
  if (
    queue.autoRepair &&
    (!queue.autoRepair.agent ||
      !Array.isArray(queue.autoRepair.checks) ||
      !queue.autoRepair.checks.length ||
      !queue.autoRepair.checks.every(
        (name) => typeof name === "string" && name.trim(),
      ) ||
      (queue.autoRepair.excludeIssues !== undefined &&
        (!Array.isArray(queue.autoRepair.excludeIssues) ||
          !queue.autoRepair.excludeIssues.every(number))))
  )
    fail("Invalid automatic repair configuration.");
  return queue;
}

export function readTask(issue, agents, allowed) {
  const blocks = [
    ...(issue.body ?? "").matchAll(
      /^\x60{3}vizor\r?\n([\s\S]*?)^\x60{3}[ \t]*\r?$/gm,
    ),
  ];
  if (blocks.length !== 1)
    fail("Expected one vizor metadata block on #" + issue.number);
  const task = JSON.parse(blocks[0][1]);
  if (
    !task ||
    !Object.hasOwn(agents, task.agent) ||
    !Array.isArray(task.dependsOn) ||
    !task.dependsOn.every(
      (dep) => number(dep) && allowed.has(dep) && dep !== issue.number,
    ) ||
    new Set(task.dependsOn).size !== task.dependsOn.length ||
    !Number.isSafeInteger(task.priority) ||
    task.priority < 0 ||
    !["review", "merge"].includes(task.gate) ||
    !Array.isArray(task.checks) ||
    !task.checks.every(
      (name) => typeof name === "string" && name.trim() === name && name.length,
    ) ||
    new Set(task.checks).size !== task.checks.length ||
    (task.gate === "merge"
      ? task.checks.length === 0
      : task.checks.length !== 0)
  ) {
    fail(
      "Invalid owner, dependencies, priority or completion gate on #" +
        issue.number,
    );
  }
  return task;
}

function assertAcyclic(tasks) {
  const visiting = new Set();
  const visited = new Set();
  function visit(issue) {
    if (visiting.has(issue)) fail("Dependency cycle includes #" + issue);
    if (visited.has(issue)) return;
    visiting.add(issue);
    tasks.get(issue)?.dependsOn.forEach(visit);
    visiting.delete(issue);
    visited.add(issue);
  }
  tasks.forEach((_, issue) => visit(issue));
}

export function openSchedulerStore(db) {
  openRecoveryStore(db);
  openBlockerStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_issues (
      issue INTEGER PRIMARY KEY,
      agent TEXT NOT NULL,
      assignment TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      result TEXT,
      pull INTEGER,
      accepted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS task_cache (issue INTEGER PRIMARY KEY, json TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, evidence TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS one_scheduled_issue_per_agent
      ON scheduled_issues(agent) WHERE active = 1;
  `);
}

export function acceptedTaskMetadata(db) {
  return db
    .prepare(
      `SELECT issue,json,evidence FROM task_cache WHERE accepted=1
      UNION ALL SELECT s.issue,c.json,c.evidence FROM scheduled_issues s LEFT JOIN task_cache c USING(issue)
      WHERE s.accepted=1 AND s.active=0 AND s.result='done'
      AND NOT EXISTS (SELECT 1 FROM task_cache a WHERE a.issue=s.issue AND a.accepted=1)`,
    )
    .all()
    .map((row) => {
      const issueData = row.json ? JSON.parse(row.json) : null;
      const block = [
        ...(issueData?.body ?? "").matchAll(
          /^\x60{3}vizor\r?\n([\s\S]*?)^\x60{3}/gm,
        ),
      ];
      return {
        issue: row.issue,
        issueData,
        task: block.length === 1 ? JSON.parse(block[0][1]) : null,
        evidence: row.evidence
          ? JSON.parse(row.evidence)
          : { kind: "previous-explicit-acceptance" },
      };
    });
}

export function acceptReview(db, issue) {
  if (
    !number(issue) ||
    !db
      .prepare(
        "UPDATE scheduled_issues SET accepted = 1 WHERE issue = ? AND result = 'done' AND active = 0 AND pull IS NULL",
      )
      .run(issue).changes
  )
    fail("Review acceptance requires a completed non-PR assignment.");
}

export function retireClaim(db, issue) {
  if (!number(issue))
    fail("Retiring a claim requires an active scheduled issue.");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare(
          "UPDATE scheduled_issues SET active = 0, result = 'retired' WHERE issue = ? AND active = 1",
        )
        .run(issue).changes
    )
      fail("Retiring a claim requires an active scheduled issue.");
    db.prepare(
      "DELETE FROM assignments WHERE issue = ? AND NOT EXISTS (SELECT 1 FROM deliveries WHERE issue = ?)",
    ).run(issue, issue);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function latest(items, predicate) {
  return items.findLast(predicate);
}

export async function scheduleTick({
  db,
  config,
  queue,
  github,
  reachable,
  dispatch,
  preview = false,
  log = console.log,
  onStatus,
  authorizeAssignment = (args) => planAssignmentAllowed(db, args),
}) {
  const repo = "repos/" + config.repository;
  const path = (issue) => repo + "/issues/" + issue;
  if (queue.paused && !preview) return log("Scheduler paused.");
  const allowed = new Set(queue.issues);
  const tasks = new Map();
  const issues = new Map();
  const cached = new Map(
    db
      .prepare("SELECT * FROM task_cache")
      .all()
      .map((r) => [r.issue, { ...r, data: JSON.parse(r.json) }]),
  );
  const cacheIssue = (data, accepted = false, evidence = null) => {
    if (!preview)
      db.prepare(
        "INSERT INTO task_cache VALUES (?,?,?,?) ON CONFLICT(issue) DO UPDATE SET json=excluded.json, accepted=max(task_cache.accepted,excluded.accepted), evidence=coalesce(excluded.evidence,task_cache.evidence)",
      ).run(data.number, JSON.stringify(data), Number(accepted), evidence);
  };
  for (const issue of queue.issues) {
    const data = cached.get(issue)?.accepted
      ? cached.get(issue).data
      : github("GET", path(issue));
    cacheIssue(data);
    // Dependencies can be pruned from the active queue; only durable accepted
    // evidence satisfies them. Fetch an unknown external prerequisite once per round.
    const block = [
      ...(data.body ?? "").matchAll(/^\x60{3}vizor\r?\n([\s\S]*?)^\x60{3}/gm),
    ];
    if (block.length === 1) {
      const deps = JSON.parse(block[0][1]).dependsOn;
      if (Array.isArray(deps))
        for (const dep of deps.filter(number)) allowed.add(dep);
    }
    if (data.pull_request || data.number !== issue)
      fail("Queue entry #" + issue + " must be an issue.");
    issues.set(issue, data);
    try {
      tasks.set(issue, readTask(data, config.agents, allowed));
    } catch (error) {
      fail(
        "Hold queue at #" +
          issue +
          ": " +
          (error instanceof SyntaxError
            ? "invalid metadata JSON"
            : error.message),
      );
    }
  }
  const external = new Map();
  for (const dep of allowed)
    if (!tasks.has(dep)) {
      const data = cached.get(dep)?.accepted
        ? cached.get(dep).data
        : github("GET", path(dep), undefined, true);
      if (data) {
        external.set(dep, data);
        const prior = db
          .prepare("SELECT * FROM scheduled_issues WHERE issue=?")
          .get(dep);
        const explicitlyAccepted =
          prior?.accepted === 1 &&
          prior.active === 0 &&
          prior.result === "done";
        cacheIssue(
          data,
          explicitlyAccepted,
          explicitlyAccepted
            ? JSON.stringify({ kind: "previous-explicit-acceptance" })
            : null,
        );
        if (explicitlyAccepted) cached.set(dep, { accepted: 1, data });
      }
    }
  assertAcyclic(tasks);
  const replacements = new Map(
    db
      .prepare(
        "SELECT issue,recheck FROM task_recoveries WHERE recheck IS NOT NULL",
      )
      .all()
      .filter((row) => allowed.has(row.issue) && allowed.has(row.recheck))
      .map((row) => [row.issue, row.recheck]),
  );
  assertAcyclic(
    new Map(
      [...tasks].map(([issue, task]) => [
        issue,
        {
          ...task,
          dependsOn: [
            ...task.dependsOn,
            ...(replacements.has(issue) ? [replacements.get(issue)] : []),
          ],
        },
      ]),
    ),
  );
  const who = github("GET", "user").login.toLowerCase();
  const rows = db.prepare("SELECT * FROM scheduled_issues");
  const receipt = db.prepare("SELECT state FROM deliveries WHERE issue = ?");
  const occupied = db.prepare(
    "SELECT issue FROM scheduled_issues WHERE agent = ? AND active = 1",
  );
  const comments = new Map();
  function readComments(issue) {
    if (!comments.has(issue)) {
      const all = [];
      for (let page = 1; ; page++) {
        const batch = github(
          "GET",
          path(issue) + "/comments?per_page=100&page=" + page,
        );
        all.push(...batch);
        if (batch.length < 100) break;
      }
      comments.set(issue, all);
    }
    return comments.get(issue);
  }
  if (!preview && queue.blockerOrchestrator === true) {
    // Reconcile authenticated GitHub results missed while offline, including manual/external/capacity gates.
    for (const row of rows
      .all()
      .filter(
        (r) =>
          queue.issues.includes(r.issue) &&
          !cached.get(r.issue)?.accepted &&
          (r.active || r.result === "blocked"),
      )) {
      const result = latest(
        readComments(row.issue),
        (c) =>
          Number.isSafeInteger(c.id) &&
          matchesCloudReturn(
            pendingCloudReturn(db, row.issue, row.assignment),
            c,
          ) &&
          BigInt(c.id) > BigInt(row.assignment) &&
          config.agents[row.agent]?.trustedManagers.some(
            (login) => login.toLowerCase() === c.user?.login?.toLowerCase(),
          ) &&
          lines(c.body).some((line) => marker.test(line)),
      );
      if (result && lines(result.body).includes("Vizor result: blocked"))
        recordBlocker({ db, config, issue: row.issue, comment: result });
    }
  }
  const capacityIssues = new Set();
  const active = preview
    ? []
    : rows
        .all()
        .filter((item) => item.active && queue.issues.includes(item.issue));
  for (const row of active) {
    if (receipt.get(row.issue)?.state !== "started") continue;
    const result = latest(
      readComments(row.issue),
      (comment) =>
        Number.isSafeInteger(comment.id) &&
        matchesCloudReturn(
          pendingCloudReturn(db, row.issue, row.assignment),
          comment,
        ) &&
        BigInt(comment.id) > BigInt(row.assignment) &&
        config.agents[row.agent]?.trustedManagers.some(
          (login) => login.toLowerCase() === comment.user?.login?.toLowerCase(),
        ) &&
        lines(comment.body).some((line) => marker.test(line)),
    );
    if (!result) continue;
    const cloudReturn = pendingCloudReturn(db, row.issue, row.assignment);
    const [, state, pull] = lines(result.body)
      .find((line) => marker.test(line))
      .match(marker);
    if (
      state === "blocked" &&
      lines(result.body).includes("Vizor blocker: capacity")
    ) {
      capacityIssues.add(row.issue);
      finishCloudReturn(db, cloudReturn, result, state);
      continue;
    }
    if (
      state === "done" &&
      ((tasks.get(row.issue).gate === "merge") !== Boolean(pull) ||
        (pull && !number(Number(pull))))
    ) {
      log("Hold #" + row.issue + ": result must match its completion gate.");
      continue;
    }
    finishCloudReturn(db, cloudReturn, result, state);
    db.prepare(
      "UPDATE scheduled_issues SET active = 0, result = ?, pull = ? WHERE issue = ? AND active = 1",
    ).run(
      cloudReturn?.preparation && state === "done" ? "blocked" : state,
      pull ? Number(pull) : null,
      row.issue,
    );
    log("#" + row.issue + " reported " + state + ".");
  }

  if (!preview && !(await reachable()))
    return log(
      "Relay or public webhook endpoint unavailable. Holding dispatch.",
    );
  if (preview && queue.paused)
    log("Queue paused. Showing eligibility without dispatch.");
  const branch = github("GET", repo).default_branch;
  const state = new Map(rows.all().map((row) => [row.issue, row]));
  const accepted = new Map();
  const completionDetail = new Map();
  function passed(issue) {
    if (accepted.has(issue)) return accepted.get(issue);
    if (replacements.has(issue)) {
      const result = passed(replacements.get(issue));
      accepted.set(issue, result);
      return result;
    }
    if (cached.get(issue)?.accepted) {
      accepted.set(issue, true);
      return true;
    }
    const task = tasks.get(issue);
    const row = state.get(issue);
    if (!task) {
      accepted.set(issue, false);
      return false;
    }
    let ok = false;
    let mergeEvidence = null;
    if (row?.result === "done" && task.gate === "review") {
      ok = Boolean(row.accepted);
      if (
        !ok &&
        queue.autoAcceptReviews === true &&
        !queue.manualReviewIssues?.includes(issue) &&
        !row.active &&
        row.pull === null &&
        receipt.get(issue)?.state === "started" &&
        validArtifactEvidence(
          latest(
            readComments(issue),
            (c) =>
              Number.isSafeInteger(c.id) &&
              BigInt(c.id) > BigInt(row.assignment) &&
              config.agents[row.agent]?.trustedManagers.some(
                (login) => login.toLowerCase() === c.user?.login?.toLowerCase(),
              ) &&
              lines(c.body).includes("Vizor result: done"),
          )?.body,
        )
      ) {
        if (!preview) {
          acceptReview(db, issue);
          log("#" + issue + " accepted from its completed artifact run.");
        }
        ok = true;
      }
    }
    if (row?.result === "done" && task.gate === "merge" && number(row.pull)) {
      const pr = github("GET", repo + "/pulls/" + row.pull, undefined, true);
      if (onStatus) {
        completionDetail.set(
          issue,
          !pr
            ? "Linked PR could not be read."
            : pr.merged
              ? "Merged PR is missing verified checks on the default branch."
              : pr.state === "closed"
                ? "Linked PR closed without merging."
                : "Waiting for the linked PR to merge.",
        );
        if (pr?.state === "open" && !pr.merged) {
          const head = pr.head?.sha;
          const base = pr.base?.sha;
          if (pr.draft)
            completionDetail.set(issue, "The linked PR is still a draft.");
          else if (
            pr.labels?.some((label) => label.name === "vizor:review-hold") ||
            issues
              .get(issue)
              .labels.some((label) => label.name === "vizor:review-hold")
          ) {
            completionDetail.set(issue, "The linked PR has a review hold.");
          } else if (pr.mergeable === false)
            completionDetail.set(issue, "The linked PR has a merge conflict.");
          else if (/^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{40}$/.test(base)) {
            const compare = github(
              "GET",
              repo + "/compare/" + base + "..." + head,
              undefined,
              true,
            );
            if (compare?.behind_by > 0) {
              completionDetail.set(
                issue,
                "The PR branch is behind " +
                  branch +
                  ". Sync it and rerun checks.",
              );
            } else {
              const checks = github(
                "GET",
                repo +
                  "/commits/" +
                  head +
                  "/check-runs?filter=latest&per_page=100",
              );
              const failed = checks.check_runs.filter(
                (run) =>
                  task.checks.includes(run.name) &&
                  [
                    "failure",
                    "cancelled",
                    "timed_out",
                    "action_required",
                  ].includes(run.conclusion),
              );
              if (failed.length)
                completionDetail.set(
                  issue,
                  "PR checks failed: " +
                    failed.map((run) => run.name).join(", ") +
                    ".",
                );
              else if (
                task.checks.some(
                  (name) =>
                    !checks.check_runs.some(
                      (run) =>
                        run.name === name && run.conclusion === "success",
                    ),
                )
              ) {
                completionDetail.set(
                  issue,
                  "Waiting for PR checks: " + task.checks.join(", ") + ".",
                );
              }
            }
          }
        }
      }
      if (
        pr?.merged &&
        pr.base?.ref === branch &&
        pr.base?.repo?.full_name.toLowerCase() ===
          config.repository.toLowerCase() &&
        pr.merge_commit_sha &&
        lines(pr.body).includes("Vizor issue: #" + issue)
      ) {
        mergeEvidence = { pull: row.pull, commit: pr.merge_commit_sha, branch };
        const checks = github(
          "GET",
          repo +
            "/commits/" +
            pr.merge_commit_sha +
            "/check-runs?filter=latest&per_page=100",
        );
        ok =
          checks.total_count <= 100 &&
          task.checks.every((name) => {
            const matches = checks.check_runs.filter(
              (run) => run.name === name,
            );
            return matches.length === 1 && matches[0].conclusion === "success";
          });
        if (onStatus && !ok) {
          const failed = task.checks.filter((name) =>
            checks.check_runs.some(
              (run) =>
                run.name === name &&
                [
                  "failure",
                  "cancelled",
                  "timed_out",
                  "action_required",
                ].includes(run.conclusion),
            ),
          );
          completionDetail.set(
            issue,
            failed.length
              ? "Post-merge checks failed: " + failed.join(", ") + "."
              : "Waiting for verified post-merge checks: " +
                  task.checks.join(", ") +
                  ".",
          );
        }
      }
    }
    if (ok && !preview)
      db.prepare(
        "UPDATE scheduled_issues SET accepted=1 WHERE issue=? AND active=0",
      ).run(issue);
    if (ok)
      cacheIssue(
        issues.get(issue),
        true,
        JSON.stringify({
          gate: task.gate,
          pull: row?.pull,
          merge: mergeEvidence,
          checks: task.checks,
          acceptedAt: new Date().toISOString(),
        }),
      );
    accepted.set(issue, ok);
    return ok;
  }

  // Close the GitHub issue once Vizor accepts it so GitHub matches the queue.
  // Dependencies read acceptance from the database, so a closed issue never blocks dependents.
  function closeAccepted(issue, row, task) {
    const reason = replacements.has(issue)
      ? "superseded by accepted recheck #" + replacements.get(issue)
      : task.gate === "merge"
        ? "PR #" +
          row.pull +
          " merged and " +
          task.checks.join(", ") +
          " passed on the merge commit"
        : "completed artifact accepted";
    try {
      github("PATCH", path(issue), {
        state: "closed",
        state_reason: "completed",
      });
      issues.get(issue).state = "closed";
      cacheIssue(issues.get(issue), true);
      github("POST", path(issue) + "/comments", {
        body: "Vizor accepted this task (" + reason + "). Closed as completed.",
      });
      log("Closed #" + issue + ": " + reason + ".");
    } catch (error) {
      log("Could not close accepted #" + issue + ": " + error.message);
    }
  }

  for (const [issue, task] of [...tasks].sort(
    ([a, x], [b, y]) => x.priority - y.priority || a - b,
  )) {
    const agent = config.agents[task.agent];
    const data = issues.get(issue);
    const row = state.get(issue);
    const currentReceipt = receipt.get(issue);
    const show = (reason, status = "waiting", waitingOn = []) => {
      if (preview) log("#" + issue + " " + reason);
      onStatus?.({
        issue,
        title: data.title,
        agent: task.agent,
        priority: task.priority,
        gate: task.gate,
        status,
        reason,
        waitingOn,
        pull: row?.pull ?? null,
        receipt: receipt.get(issue)?.state ?? currentReceipt?.state ?? null,
      });
    };
    if (row && !row.active) {
      const complete = passed(issue);
      if (complete && !preview && data.state === "open")
        closeAccepted(issue, row, task);
      if (complete) show("accepted.", "complete");
      else if (row.result === "blocked")
        show(
          "Worker reported a blocker. Open the issue for the worker’s report.",
          "blocked",
        );
      else if (row.result === "retired")
        show("The assignment was retired.", "blocked");
      else if (task.gate === "review")
        show("Waiting for artifact acceptance.", "review");
      else
        show(
          completionDetail.get(issue) ?? "Waiting for verified merge evidence.",
          "checks",
        );
      continue;
    }
    const recoverClaim =
      (dispatch || (preview && queue.dispatchMode === "local")) &&
      row?.active &&
      row.agent === task.agent &&
      !currentReceipt;
    if (!recoverClaim && (row || currentReceipt)) {
      if (!onStatus) show("already claimed or dispatched.");
      else if (
        capacityIssues.has(issue) ||
        db
          .prepare(
            "SELECT kind,state FROM blocker_runs WHERE issue=? AND assignment=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(issue, row?.assignment)?.kind === "capacity"
      )
        show(
          "Worker usage limit: preserving the same session and occupied assignment; no replacement will be fired.",
          "capacity",
        );
      else if (currentReceipt?.state === "started")
        show(
          "Provider start confirmed; current activity is unknown. Waiting for a result (capacity holds retain this assignment).",
          "started",
        );
      else if (currentReceipt)
        show(
          "Provider start unconfirmed. Check the run history before retrying.",
          "blocked",
        );
      else show("Claim recorded. Waiting for a delivery receipt.", "blocked");
      continue;
    }
    if (data.state !== "open") {
      show("Issue is closed without a completed assignment.", "blocked");
      continue;
    }
    if (!agent.trustedManagers.some((login) => login.toLowerCase() === who)) {
      show("GitHub account lacks assignment authority.", "blocked");
      continue;
    }
    const waiting = task.dependsOn.filter((dependency) => !passed(dependency));
    if (waiting.length) {
      const closed = waiting.filter(
        (dep) => (issues.get(dep) ?? external.get(dep))?.state === "closed",
      );
      const unavailable = waiting.filter((dep) => !tasks.has(dep));
      show(
        closed.length
          ? "Blocked by closed, unaccepted prerequisite #" +
              closed.join(", #") +
              " (including not-planned closures)."
          : unavailable.length
            ? "Blocked by unaccepted prerequisite outside the active queue #" +
              unavailable.join(", #") +
              ". Reconcile its acceptance or schedule it."
            : "waiting for #" + waiting.join(", #") + ".",
        closed.length || unavailable.length ? "blocked" : "waiting",
        waiting,
      );
      continue;
    }
    const labels = data.labels.map((label) => label.name);
    if (
      labels.includes("vizor:paused") ||
      (!recoverClaim && labels.includes(config.dispatchLabel)) ||
      !labels.includes(agent.label) ||
      Object.values(config.agents).some(
        (other) => other !== agent && labels.includes(other.label),
      )
    ) {
      show("Issue paused or missing the expected owner label.", "blocked");
      continue;
    }
    const reserved = occupied.get(task.agent);
    if (reserved && !recoverClaim) {
      show(agent.name + " is occupied by #" + reserved.issue + ".");
      continue;
    }
    const comment = latest(
      readComments(issue),
      (item) =>
        item.user?.login?.toLowerCase() === who &&
        lines(item.body).includes("### Task for " + agent.name) &&
        authorizeAssignment({ issue, comment: item, agent: task.agent, task }),
    );
    if (!comment || !Number.isSafeInteger(comment.id)) {
      show("Missing a trusted assignment comment.", "blocked");
      continue;
    }
    if (recoverClaim) {
      if (String(comment.id) !== row.assignment) {
        show("Assignment changed after claim.", "blocked");
        continue;
      }
      if (preview) {
        show(
          "Eligible to resume its recorded claim.",
          queue.paused ? "waiting" : "ready",
        );
        continue;
      }
      if (!labels.includes(config.dispatchLabel)) {
        github("POST", path(issue) + "/labels", {
          labels: [config.dispatchLabel],
        });
      }
      if (await dispatch(issue))
        log("Released recorded claim #" + issue + " to " + agent.name + ".");
      continue;
    }
    if (preview) {
      show(
        queue.paused && onStatus
          ? "Queue is paused."
          : "eligible for " + agent.name + ".",
        queue.paused ? "waiting" : "ready",
      );
      continue;
    }
    // Serialize the issue and agent claim before the webhook can arrive.
    db.exec("BEGIN IMMEDIATE");
    let claimed;
    try {
      claimed =
        !receipt.get(issue) &&
        db
          .prepare(
            "INSERT INTO scheduled_issues (issue, agent, assignment) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
          )
          .run(issue, task.agent, String(comment.id)).changes;
      if (claimed) {
        const link =
          "https://github.com/" +
          config.repository +
          "/issues/" +
          issue +
          "#issuecomment-" +
          comment.id;
        db.prepare(
          "INSERT INTO assignments VALUES (?, ?, ?) ON CONFLICT(issue) DO UPDATE SET agent = excluded.agent, comment = excluded.comment",
        ).run(issue, task.agent, link);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Only the winning claim publishes the label. An interrupted claim stays visible for review.
    if (!claimed) continue;
    github("POST", path(issue) + "/labels", { labels: [config.dispatchLabel] });
    if (dispatch) await dispatch(issue);
    log("Released #" + issue + " to " + agent.name + ".");
    const confirmed = receipt.get(issue)?.state === "started";
    show(
      confirmed
        ? "Provider start confirmed; current activity is unknown."
        : "Dispatch reserved; provider start unconfirmed. Check run history before retrying.",
      confirmed ? "started" : "unconfirmed",
    );
  }
}

export async function runScheduler({ file, once, ...input }) {
  const startId = randomUUID();
  const startedAt = new Date().toISOString();
  // Only one runner may dispatch this project's queue. A second start (another
  // task, a manual schedule, or an upgrade overlapping the old version) exits
  // here before touching GitHub or the provider.
  const lease = input.preview
    ? null
    : acquireLease(input.db, {
        queue: resolve(file),
        executable: resolve(process.argv[1] ?? "vizor"),
      });
  const services = lease
    ? {
        ...input,
        dispatch:
          input.dispatch &&
          (async (issue) => {
            lease.assert();
            return input.dispatch(issue);
          }),
      }
    : input;
  const release = () => lease?.release();
  const onSignal = (signal) => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  if (lease && !once) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("exit", release);
  }
  try {
    await schedulerLoop({ file, once, services, lease, startId, startedAt });
  } finally {
    if (lease && !once) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("exit", release);
    }
    release();
  }
}

async function schedulerLoop({
  file,
  once,
  services,
  lease,
  startId,
  startedAt,
}) {
  for (;;) {
    const roundStart = Date.now();
    const statuses = [];
    const errors = [];
    let queue;
    let planStatus = null;
    const previous = readRuntimeSnapshot(file).snapshot;
    if (!services.preview)
      atomicJson(snapshotPath(file), {
        ...previous,
        schema: "vizor.scheduler/1",
        repository: services.config.repository,
        project: process.cwd(),
        executable: resolve(process.argv[1]),
        queue: resolve(file),
        pid: process.pid,
        startId,
        startedAt,
        updatedAt: new Date().toISOString(),
        roundStartedAt: new Date(roundStart).toISOString(),
        roundState: "syncing",
        errors: [],
        tasks: previous?.tasks ?? [],
        tasksObservedAt: previous?.tasksObservedAt ?? null,
        agents: Object.entries(services.config.agents).map(
          ([id, { name }]) => ({ id, name }),
        ),
      });
    const baseLog = services.log ?? console.log;
    const roundServices = {
      ...services,
      log: (value) => baseLog(logLine(value)),
      onStatus: (status) => {
        statuses.push(status);
        services.onStatus?.(status);
      },
    };
    try {
      lease?.assert();
      queue = readQueue(file);
      if (!services.preview) {
        try {
          if (queue.blockerOrchestrator !== true)
            recoverBlockedTasks({
              ...services,
              queue,
              file,
              parseTask: readTask,
            });
        } catch (error) {
          errors.push("Recovery needs reconciliation: " + error.message);
          console.error(logLine(errors.at(-1)));
        }
      }
      if (!services.preview && queue.planFile) {
        try {
          planStatus = publishApprovedPhases({
            ...services,
            log: roundServices.log,
            queue,
            file,
          });
        } catch (error) {
          planStatus = { state: "holding", detail: error.message };
          errors.push(
            "Plan publication holding; queued work continues: " + error.message,
          );
          console.error(logLine(errors.at(-1)));
        }
      }
      await scheduleTick({ ...roundServices, queue });
      if (!services.preview && queue.blockerOrchestrator === true) {
        try {
          advanceCloudRechecks({ ...services, queue });
          orchestratorTick({ ...services, queue, file, parseTask: readTask });
        } catch {
          errors.push(
            "Blocker orchestrator configuration needs reconciliation; independent work continues.",
          );
          console.error(logLine(errors.at(-1)));
        }
      }
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      errors.push(
        error instanceof SyntaxError ? "Invalid queue JSON" : error.message,
      );
      if (once) {
        throw error;
      }
      console.error(
        logLine(
          "Scheduler holding dispatch: " +
            (error instanceof SyntaxError
              ? "invalid queue JSON"
              : error.message),
        ),
      );
    } finally {
      if (!services.preview) {
        const finishedAt = new Date().toISOString();
        atomicJson(snapshotPath(file), {
          schema: "vizor.scheduler/1",
          queue: resolve(file),
          repository: services.config.repository,
          pid: process.pid,
          startId,
          startedAt,
          updatedAt: finishedAt,
          roundStartedAt: new Date(roundStart).toISOString(),
          roundDurationMs: Date.now() - roundStart,
          mode: queue?.dispatchMode ?? "webhook",
          paused: queue?.paused ?? true,
          lastSuccessfulGitHubSync:
            services.github.budget?.().lastSuccessfulSync ?? null,
          rate: services.github.budget?.() ?? null,
          errors,
          roundState: errors.length ? "holding" : "idle",
          project: process.cwd(),
          executable: resolve(process.argv[1]),
          tasks:
            !statuses.length && (errors.length || queue?.paused)
              ? (previous?.tasks ?? [])
              : statuses,
          tasksObservedAt:
            errors.length && !statuses.length
              ? (previous?.tasksObservedAt ?? null)
              : finishedAt,
          nextEligible: statuses.filter((t) => t.status === "ready"),
          blockedTasks: statuses.filter((t) => t.status === "blocked"),
          agents: Object.entries(services.config.agents).map(
            ([id, { name }]) => ({ id, name }),
          ),
          blockers: blockerSnapshot(services.db),
          plan: planStatus ?? previous?.plan ?? null,
        });
      }
    }
    if (once) return;
    await delay(45000);
  }
}
