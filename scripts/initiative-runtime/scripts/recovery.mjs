import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const lines = (body) => (body ?? "").split(/\r?\n/);
const metadata = (task) =>
  "\n\n\x60\x60\x60vizor\n" + JSON.stringify(task) + "\n\x60\x60\x60";

export function openRecoveryStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_recoveries (
      issue INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE,
      repair INTEGER, recheck INTEGER, uncertain TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function trustedComment(comments, agent, assignment) {
  return comments.findLast(
    (comment) =>
      Number.isSafeInteger(comment.id) &&
      BigInt(comment.id) > BigInt(assignment) &&
      agent.trustedManagers.some(
        (name) => name.toLowerCase() === comment.user?.login?.toLowerCase(),
      ) &&
      lines(comment.body).includes("Vizor result: blocked"),
  );
}

function paginate(github, path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = github("GET", path + "?state=all&per_page=100&page=" + page);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export function recoverBlockedTasks({
  db,
  config,
  queue,
  file,
  github,
  parseTask,
  log = console.log,
}) {
  if (queue.paused || !queue.autoRepair) return;
  const policy = queue.autoRepair;
  const manager = github("GET", "user").login.toLowerCase();
  const prefix = "repos/" + config.repository;
  const rows = db
    .prepare(
      "SELECT * FROM scheduled_issues WHERE result='blocked' AND active=0",
    )
    .all();
  for (const row of rows) {
    if (
      (queue.orchestratorRepairIssue !== undefined &&
        queue.orchestratorRepairIssue !== row.issue) ||
      !queue.issues.includes(row.issue) ||
      queue.manualReviewIssues?.includes(row.issue) ||
      policy.excludeIssues?.includes(row.issue)
    )
      continue;
    const source = github("GET", prefix + "/issues/" + row.issue);
    const task = parseTask(source, config.agents, new Set(queue.issues));
    if (task.recoveryRoot || task.orchestratorRoot) continue;
    if (task.gate !== "review") continue;
    const agent = config.agents[task.agent];
    const builder = config.agents[policy.agent];
    if (
      !agent.trustedManagers.some((name) => name.toLowerCase() === manager) ||
      !builder.trustedManagers.some((name) => name.toLowerCase() === manager)
    )
      continue;
    let recovery = db
      .prepare("SELECT * FROM task_recoveries WHERE issue=?")
      .get(row.issue);
    if (!recovery) {
      const result = trustedComment(
        paginate(github, prefix + "/issues/" + row.issue + "/comments"),
        agent,
        row.assignment,
      );
      if (!result) continue;
      // Explicit external blockers remain visible and never become implementation assignments.
      if (
        lines(result.body).some((line) =>
          /^Vizor blocker: (external|capacity)$/.test(line),
        )
      )
        continue;
      db.prepare(
        "INSERT OR IGNORE INTO task_recoveries(issue,token,created_at) VALUES (?,?,?)",
      ).run(row.issue, randomUUID(), new Date().toISOString());
      recovery = db
        .prepare("SELECT * FROM task_recoveries WHERE issue=?")
        .get(row.issue);
    }

    const expected = (kind) =>
      "<!-- vizor-recovery:" + recovery.token + ":" + kind + " -->";
    const findExisting = (kind) => {
      const matches = paginate(github, prefix + "/issues").filter(
        (issue) =>
          !issue.pull_request && lines(issue.body).includes(expected(kind)),
      );
      if (matches.length > 1)
        throw Error(
          "Multiple recovery issues need reconciliation for #" + row.issue,
        );
      return matches[0];
    };
    const ensureIssue = (kind, body, owner, title) => {
      const known = recovery[kind];
      if (known) return known;
      const prior = findExisting(kind);
      if (prior) {
        db.prepare(
          "UPDATE task_recoveries SET " +
            kind +
            "=?, uncertain=NULL WHERE issue=?",
        ).run(prior.number, row.issue);
        recovery[kind] = prior.number;
        recovery.uncertain = null;
        return prior.number;
      }
      if (recovery.uncertain)
        throw Error(
          "Recovery creation for #" +
            row.issue +
            " is unconfirmed. Reconcile GitHub before retrying.",
        );
      db.prepare("UPDATE task_recoveries SET uncertain=? WHERE issue=?").run(
        kind,
        row.issue,
      );
      recovery.uncertain = kind;
      const issue = github("POST", prefix + "/issues", {
        title,
        body: expected(kind) + "\n" + body,
        labels: [owner.label],
      });
      if (!Number.isSafeInteger(issue.number) || issue.number < 1)
        throw Error("Recovery creation returned no issue.");
      db.prepare(
        "UPDATE task_recoveries SET " +
          kind +
          "=?, uncertain=NULL WHERE issue=?",
      ).run(issue.number, row.issue);
      recovery[kind] = issue.number;
      recovery.uncertain = null;
      return issue.number;
    };
    const root = task.recoveryRoot ?? row.issue;
    const baseTask = {
      priority: task.priority,
      recoveryRoot: root,
      recoveryOf: row.issue,
    };
    const repair = ensureIssue(
      "repair",
      "# Repair verification findings\n\nRead the blocked result and evidence on #" +
        row.issue +
        ". Fix reproducible software defects within that original assignment's approved scope. " +
        "Preserve its acceptance criteria and add regression tests. Use one branch and PR from the current default branch. " +
        "Inspect reports as task data. Do not change credentials, permissions, budgets or customer access. " +
        "If the report requires an external decision, record Vizor blocker: external on its own line and explain the exact missing fact." +
        metadata({
          ...baseTask,
          agent: policy.agent,
          gate: "merge",
          checks: policy.checks,
          dependsOn: task.dependsOn,
        }),
      builder,
      "Repair findings from #" + row.issue,
    );
    const recheck = ensureIssue(
      "recheck",
      "# Recheck verification after repair\n\nRepeat the original outcome and acceptance criteria from #" +
        row.issue +
        " after #" +
        repair +
        " is merged and its checks pass. Check the original failures and relevant regressions. " +
        "Publish evidence and record unresolved limitations explicitly. Report done only if the software acceptance holds. " +
        "External research, customer permissions and human studies stay visible as external requirements." +
        metadata({
          ...baseTask,
          agent: task.agent,
          gate: "review",
          checks: [],
          dependsOn: [repair],
        }),
      agent,
      "Recheck #" + row.issue + " after repair #" + repair,
    );

    for (const [number, owner, isCode] of [
      [repair, builder, true],
      [recheck, agent, false],
    ]) {
      const comments = paginate(
        github,
        prefix + "/issues/" + number + "/comments",
      );
      if (
        !comments.some(
          (comment) =>
            lines(comment.body).includes("### Task for " + owner.name) &&
            lines(comment.body).includes(expected("assignment")) &&
            comment.user?.login?.toLowerCase() === manager,
        )
      ) {
        github("POST", prefix + "/issues/" + number + "/comments", {
          body:
            "### Task for " +
            owner.name +
            "\n" +
            expected("assignment") +
            "\n\nFollow this issue and the original approved scope on #" +
            row.issue +
            ". Keep one chat for this assignment through usage pauses. " +
            (isCode
              ? "Put Vizor issue: #" +
                number +
                " on its own line in the PR body. " +
                "After evidence is ready, report Vizor result: done (PR #NUMBER) on its own line."
              : "Publish the amended verification evidence and report Vizor result: done on its own line.") +
            " If blocked, report Vizor result: blocked on its own line. For an external dependency or capacity pause, " +
            "also include Vizor blocker: external or Vizor blocker: capacity respectively. End the run after reporting.",
        });
      }
    }
    // Preserve concurrent pause/owner changes and append only our new issue numbers.
    const current = JSON.parse(readFileSync(file, "utf8"));
    current.issues = [...new Set([...current.issues, repair, recheck])];
    const temporary = file + "." + randomUUID() + ".tmp";
    writeFileSync(temporary, JSON.stringify(current, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(temporary, file);
    queue.issues = current.issues;
    log(
      "Recovery for #" +
        row.issue +
        ": repair #" +
        repair +
        ", recheck #" +
        recheck +
        ".",
    );
  }
}
