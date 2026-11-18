// Publishes the next approved phase of the project's plan once every earlier
// phase is accepted. The plan is read from the repository's default branch,
// where only owner-reviewed changes land. An empty queue never invents work:
// without an approved next phase the runtime reports that the plan is complete.
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { validatePlan } from "./approvals.mjs";

const lines = (body) => (body ?? "").split(/\r?\n/);
const marker = (plan, key, kind = "issue") =>
  "<!-- vizor-plan:" + plan + "/" + key + ":" + kind + " -->";

export function openPlanStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_tasks (
      plan TEXT NOT NULL, task TEXT NOT NULL, phase TEXT NOT NULL,
      issue INTEGER, assignment TEXT, uncertain TEXT, published_at TEXT,
      PRIMARY KEY(plan, task)
    );
  `);
}

// Only the assignment comment this runtime published may authorize a plan task.
// A copied "### Task for" heading from the shared GitHub identity is ignored.
export function planAssignmentAllowed(db, { issue, comment }) {
  openPlanStore(db);
  const row = db
    .prepare("SELECT assignment FROM plan_tasks WHERE issue=?")
    .get(issue);
  return !row || row.assignment === String(comment.id);
}

export function readApprovedPlan({ github, config, planFile }) {
  if (
    typeof planFile !== "string" ||
    !/^[\w.-]+(\/[\w.-]+)*\.json$/.test(planFile) ||
    planFile.split("/").some((part) => part === "." || part === "..")
  )
    throw Error("Invalid approved plan path.");
  const repo = "repos/" + config.repository;
  const meta = github("GET", repo);
  const file = github(
    "GET",
    repo +
      "/contents/" +
      planFile +
      "?ref=" +
      encodeURIComponent(meta.default_branch),
    undefined,
    true,
  );
  if (!file) return null;
  if (file.encoding !== "base64" || typeof file.content !== "string")
    throw Error("Approved plan is not a readable file.");
  const plan = validatePlan(
    JSON.parse(Buffer.from(file.content, "base64").toString("utf8")),
    config.agents,
  );
  if (plan.repository !== config.repository)
    throw Error("Approved plan belongs to another repository.");
  return { plan, revision: file.sha };
}

function accepted(db, issue) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM task_cache WHERE issue=? AND accepted=1 UNION SELECT 1 FROM scheduled_issues WHERE issue=? AND accepted=1",
      )
      .get(issue, issue),
  );
}

function paginate(github, path) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = github(
      "GET",
      path + (path.includes("?") ? "&" : "?") + "per_page=100&page=" + page,
    );
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

// Returns a status object for the dashboard. Throws to hold publication only.
export function publishApprovedPhases({
  db,
  config,
  queue,
  file,
  github,
  log = console.log,
}) {
  if (!queue.planFile || queue.paused) return null;
  openPlanStore(db);
  const approved = readApprovedPlan({
    github,
    config,
    planFile: queue.planFile,
  });
  if (!approved)
    return {
      state: "missing",
      detail: "No approved plan on the default branch.",
    };
  const { plan } = approved;
  const repo = "repos/" + config.repository;
  const manager = github("GET", "user").login.toLowerCase();
  const rows = new Map(
    db
      .prepare("SELECT * FROM plan_tasks WHERE plan=?")
      .all(plan.id)
      .map((row) => [row.task, row]),
  );
  const issueOf = (key) => rows.get(key)?.issue ?? null;
  let current = null;
  for (const phase of plan.phases) {
    const published = phase.tasks.every((task) => issueOf(task.key));
    const done =
      published && phase.tasks.every((task) => accepted(db, issueOf(task.key)));
    if (done) continue;
    current = phase;
    if (published)
      return {
        plan: plan.id,
        phase: phase.id,
        state: "running",
        detail:
          "Phase " +
          phase.id +
          " is published; waiting for its accepted results.",
      };
    break;
  }
  if (!current)
    return {
      plan: plan.id,
      phase: null,
      state: "complete",
      detail:
        "Every approved phase is accepted. No further work will be invented.",
    };
  const existing = (kind, key) => {
    const wanted = marker(plan.id, key, kind);
    const found =
      kind === "issue"
        ? paginate(github, repo + "/issues?state=all").filter(
            (item) => !item.pull_request && lines(item.body).includes(wanted),
          )
        : paginate(
            github,
            repo + "/issues/" + issueOf(key) + "/comments",
          ).filter(
            (item) =>
              item.user?.login?.toLowerCase() === manager &&
              lines(item.body).includes(wanted),
          );
    if (found.length > 1)
      throw Error(
        "Multiple published copies of plan task " +
          key +
          " need reconciliation.",
      );
    return found[0] ?? null;
  };
  const created = [];
  for (const task of current.tasks) {
    const agent = config.agents[task.agent];
    if (!agent.trustedManagers.some((login) => login.toLowerCase() === manager))
      throw Error("GitHub account lacks assignment authority for " + task.key);
    db.prepare(
      "INSERT OR IGNORE INTO plan_tasks(plan,task,phase) VALUES (?,?,?)",
    ).run(plan.id, task.key, current.id);
    let row = db
      .prepare("SELECT * FROM plan_tasks WHERE plan=? AND task=?")
      .get(plan.id, task.key);
    rows.set(task.key, row);
    const save = (column, value) => {
      db.prepare(
        "UPDATE plan_tasks SET " +
          column +
          "=?, uncertain=NULL WHERE plan=? AND task=?",
      ).run(value, plan.id, task.key);
      row = { ...row, [column]: value, uncertain: null };
      rows.set(task.key, row);
    };
    const reserve = (kind) => {
      // An unconfirmed write is never repeated; its marker must be found first.
      if (row.uncertain)
        throw Error(
          "Publication of plan task " +
            task.key +
            " is unconfirmed. Reconcile GitHub before retrying.",
        );
      db.prepare(
        "UPDATE plan_tasks SET uncertain=? WHERE plan=? AND task=?",
      ).run(kind, plan.id, task.key);
      row = { ...row, uncertain: kind };
    };
    if (!row.issue) {
      const prior = existing("issue", task.key);
      if (prior) save("issue", prior.number);
      else {
        const dependsOn = task.dependsOn.map((key) => {
          const dep = issueOf(key);
          if (!dep) throw Error("Plan dependency " + key + " is unpublished.");
          return dep;
        });
        reserve("issue");
        const issue = github("POST", repo + "/issues", {
          title: task.title,
          labels: [agent.label],
          body:
            marker(plan.id, task.key) +
            "\n" +
            task.body +
            "\n\nApproved plan: `" +
            plan.id +
            "`, phase `" +
            current.id +
            "`. Allowed files: " +
            (task.paths.length
              ? task.paths.join(", ")
              : "none (review artifact)") +
            ".\n\n\x60\x60\x60vizor\n" +
            JSON.stringify({
              agent: task.agent,
              dependsOn,
              priority: task.priority,
              gate: task.gate,
              checks: task.checks,
              plan: plan.id + "/" + task.key,
            }) +
            "\n\x60\x60\x60",
        });
        if (!Number.isSafeInteger(issue?.number) || issue.number < 1)
          throw Error("Plan task creation returned no issue.");
        save("issue", issue.number);
        created.push(issue.number);
      }
    }
    if (!row.assignment) {
      const prior = existing("assignment", task.key);
      if (prior) save("assignment", String(prior.id));
      else {
        reserve("assignment");
        const comment = github(
          "POST",
          repo + "/issues/" + row.issue + "/comments",
          {
            body:
              "### Task for " +
              agent.name +
              "\n" +
              marker(plan.id, task.key, "assignment") +
              "\n\n" +
              task.assignment +
              "\n\nStart from the current default branch. Keep one chat for this assignment through usage pauses. " +
              (task.gate === "merge"
                ? "Change only the allowed files listed on the issue. Put Vizor issue: #" +
                  row.issue +
                  " on its own line in the PR body, then report Vizor result: done (PR #NUMBER) on its own line."
                : "Publish the evidence as an immutable link and report Vizor result: done on its own line.") +
              " If blocked, report Vizor result: blocked on its own line; for an external dependency or capacity pause also include Vizor blocker: external or Vizor blocker: capacity. End the run after reporting.",
          },
        );
        if (!Number.isSafeInteger(comment?.id))
          throw Error("Plan assignment creation returned no comment.");
        save("assignment", String(comment.id));
      }
    }
    db.prepare(
      "UPDATE plan_tasks SET published_at=coalesce(published_at,?) WHERE plan=? AND task=?",
    ).run(new Date().toISOString(), plan.id, task.key);
  }
  // Preserve concurrent owner edits and append only this phase's issues.
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const issues = current.tasks.map((task) => issueOf(task.key));
  saved.issues = [...new Set([...saved.issues, ...issues])];
  const temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(saved, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
  queue.issues = saved.issues;
  log(
    "Published approved phase " +
      current.id +
      " of " +
      plan.id +
      ": #" +
      issues.join(", #") +
      (created.length ? "" : " (reconciled)") +
      ".",
  );
  return {
    plan: plan.id,
    phase: current.id,
    state: "published",
    detail: "Published phase " + current.id + ": #" + issues.join(", #") + ".",
  };
}
