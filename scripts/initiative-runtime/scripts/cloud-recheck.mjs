import { readFileSync } from "node:fs";
import { lifecycleObservation } from "./claude-lifecycle.mjs";
import { cloudSession, sendCloudMessage } from "./cloud-return.mjs";
import { activity } from "./blockers.mjs";

export function advanceCloudRecheck({
  db,
  config,
  issue,
  host,
  observe = lifecycleObservation,
  send = sendCloudMessage,
}) {
  const saved = db
    .prepare(
      `SELECT r.*,s.assignment AS current_assignment,s.active,s.agent AS current_agent,
    a.comment,d.state FROM cloud_rechecks r JOIN scheduled_issues s USING(issue)
    JOIN assignments a USING(issue) JOIN deliveries d USING(issue) WHERE r.issue=?`,
    )
    .get(issue);
  if (
    !saved ||
    saved.state !== "waiting_lifecycle" ||
    !saved.active ||
    saved.current_agent !== saved.agent
  )
    return;
  const root = db
    .prepare("SELECT * FROM blocker_runs WHERE id=?")
    .get(saved.blocker_run);
  const source = db
    .prepare("SELECT session FROM deliveries WHERE issue=?")
    .get(saved.original);
  if (
    !root ||
    source?.session !== saved.session ||
    root.agent !== saved.agent ||
    root.assignment !== saved.assignment ||
    saved.comment !==
      `https://github.com/${config.repository}/issues/${issue}#issuecomment-${saved.current_assignment}`
  )
    return;
  host ??= JSON.parse(readFileSync(".vizor/orchestrator-host.json", "utf8"));
  if (host.cloudReturn?.type !== "claude-cloud-cli") return;
  const observation = observe({
    db,
    config,
    host,
    issue,
    assignment: saved.current_assignment,
    session: saved.session,
    agent: saved.agent,
    reportedAt: root.reported_at,
  });
  if (observation.state === "usage_paused") return;
  if (
    !db
      .prepare(
        "UPDATE deliveries SET state='cloud_sending' WHERE issue=? AND state='waiting_lifecycle'",
      )
      .run(issue).changes
  )
    return;
  activity(
    db,
    root.id,
    "cloud_recheck_sending",
    `Queueing checked recheck #${issue} in the original verifier cloud session.`,
  );
  let outcome;
  try {
    outcome = send({
      executable: host.cloudReturn.executable,
      session: cloudSession(saved.session),
      text: `Vizor recheck for ${config.repository}#${issue}, continuing the original task #${saved.original} in this exact cloud chat. Read the authorized assignment at ${saved.comment}. Verify its author, repository and heading. Its repair dependency has passed the normal scheduler merge/check gate. Do not create another chat or take another task.`,
    });
  } catch {
    outcome = {
      state: "uncertain",
      detail: "Recheck message response lost; no automatic retry or Fire.",
    };
  }
  db.prepare("UPDATE deliveries SET state=?,session=? WHERE issue=?").run(
    outcome.state === "queued" ? "started" : "cloud_" + outcome.state,
    saved.session,
    issue,
  );
  activity(db, root.id, "cloud_recheck_" + outcome.state, outcome.detail);
}

export function advanceCloudRechecks({ db, config, queue, ...services }) {
  for (const row of db
    .prepare(
      "SELECT r.issue FROM cloud_rechecks r JOIN deliveries d USING(issue) WHERE d.state='waiting_lifecycle'",
    )
    .all())
    if (queue.issues.includes(row.issue) && !queue.paused)
      advanceCloudRecheck({ db, config, issue: row.issue, ...services });
}
