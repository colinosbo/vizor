import { spawnSync } from "node:child_process";
import { activity } from "./blockers.mjs";

export function openCloudReturnStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_returns (
    run TEXT PRIMARY KEY, issue INTEGER NOT NULL, agent TEXT NOT NULL,
    original_assignment TEXT NOT NULL, assignment TEXT NOT NULL,
    session TEXT NOT NULL, state TEXT NOT NULL, preparation INTEGER NOT NULL,
    result_comment TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, UNIQUE(issue,assignment)
  );`);
}

export function cloudSession(value) {
  const url = typeof value === "string" && URL.parse(value);
  return url?.origin === "https://claude.ai" &&
    !url.username &&
    !url.password &&
    /^\/code\/((?:session|cse)_[A-Za-z0-9_-]+)$/.test(url.pathname)
    ? url.pathname.slice(6)
    : null;
}

export function sendCloudMessage({
  executable,
  session,
  text,
  execute = spawnSync,
}) {
  const env = { ...process.env };
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ])
    delete env[key];
  const result = execute(
    executable,
    ["-p", "--cloud", session, "--output-format", "json"],
    {
      input: text,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      env,
      timeout: 45000,
      maxBuffer: 1024 * 1024,
    },
  );
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    /* Never accept prose as a provider receipt. */
  }
  if (
    !result.error &&
    result.status === 0 &&
    data?.ok === true &&
    data.session_id === session &&
    (!data.url ||
      cloudSession(data.url)?.replace(/^session_/, "cse_") ===
        session.replace(/^session_/, "cse_"))
  )
    return {
      state: "queued",
      detail:
        "Provider confirmed a message queued in the exact existing cloud session; end state is not asserted.",
    };
  if (data?.ok === false && data.session_id === session)
    return {
      state: "rejected",
      detail:
        "Provider rejected delivery to this session. Check session access/archive state; no new session was started.",
    };
  const diagnostic = String(result.stderr ?? "");
  if (
    !result.error &&
    /not logged in|please (?:run|log in)|authentication required|login required/i.test(
      diagnostic,
    )
  )
    return {
      state: "auth_required",
      detail:
        "Claude CLI needs the same-account subscription sign-in. Run claude auth login --claudeai, then reconcile this reserved send; no Fire fallback.",
    };
  return {
    state: "uncertain",
    detail:
      "Cloud message delivery is unconfirmed (timeout, unknown output or session mismatch). Inspect the existing chat for the return token; never blindly resend or Fire.",
  };
}

export function pendingCloudReturn(db, issue, assignment) {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE name='cloud_returns'")
      .get()
  )
    return undefined;
  return db
    .prepare("SELECT * FROM cloud_returns WHERE issue=? AND assignment=?")
    .get(issue, String(assignment));
}

export function matchesCloudReturn(record, comment) {
  return (
    !record ||
    comment.body?.split(/\r?\n/).includes("Vizor return: " + record.run)
  );
}

export function finishCloudReturn(db, record, comment, result) {
  if (!record) return;
  const capacity =
    result === "blocked" &&
    comment.body.split(/\r?\n/).includes("Vizor blocker: capacity");
  const state = capacity
    ? "usage_paused"
    : result === "done"
      ? "completed"
      : "blocked";
  if (record.result_comment === String(comment.id) && record.state === state)
    return;
  db.prepare(
    "UPDATE cloud_returns SET state=?,result_comment=?,updated_at=? WHERE run=?",
  ).run(state, String(comment.id), new Date().toISOString(), record.run);
  const investigatorState = capacity
    ? "worker_usage_paused"
    : record.preparation && result === "done"
      ? "preparation_complete"
      : "return_" + state;
  db.prepare("UPDATE blocker_runs SET state=? WHERE id=?").run(
    investigatorState,
    record.run,
  );
  activity(
    db,
    record.run,
    investigatorState,
    `Bound return result on #${record.issue}: ${state}. Same cloud session retained; provider termination is not inferred.`,
  );
}

export function queueCloudReturn({
  db,
  config,
  run,
  task,
  host,
  preparation,
  post,
  send = sendCloudMessage,
}) {
  const hold = (state, detail) => {
    if (run.state !== state) activity(db, run.id, state, detail);
    db.prepare("UPDATE blocker_runs SET state=? WHERE id=?").run(state, run.id);
  };
  const provider = host.cloudReturn;
  if (
    provider?.type !== "claude-cloud-cli" ||
    typeof provider.executable !== "string"
  )
    return hold(
      "cloud_configuration_required",
      "Configure the supported authenticated Claude CLI cloud-return adapter; no replacement worker is started.",
    );
  let record = db
    .prepare("SELECT * FROM cloud_returns WHERE run=?")
    .get(run.id);
  if (record && record.state !== "prepared") {
    if (
      record.state === "sending" &&
      Date.now() - Date.parse(record.updated_at) > 60000
    ) {
      const detail =
        "Send was interrupted before a provider receipt was saved. Inspect this exact session for the return token; no automatic resend or replacement.";
      db.prepare(
        "UPDATE cloud_returns SET state='uncertain',detail=? WHERE run=?",
      ).run(detail, run.id);
      hold("cloud_uncertain", detail);
    } else if (record.state !== "sending") {
      hold(
        record.state === "completed"
          ? record.preparation
            ? "preparation_complete"
            : "return_completed"
          : "cloud_" + record.state,
        record.detail,
      );
    }
    return;
  }
  if (!record) {
    const row = db
      .prepare("SELECT * FROM scheduled_issues WHERE issue=?")
      .get(run.issue);
    const receipt = db
      .prepare("SELECT * FROM deliveries WHERE issue=?")
      .get(run.issue);
    const session = cloudSession(receipt?.session);
    if (preparation && task.gate !== "review")
      return hold(
        "held",
        "Preparation must remain a separate review result; no code-task acceptance is substituted.",
      );
    if (
      !session ||
      receipt.state !== "started" ||
      row.agent !== run.agent ||
      row.assignment !== run.assignment
    )
      return hold(
        "cloud_binding_required",
        "Missing or changed saved provider session/assignment. Reconcile it before return.",
      );
    if (
      db.prepare("SELECT run FROM cloud_returns WHERE issue=?").get(run.issue)
    )
      return hold(
        "held",
        "A return already exists for this original issue. Reconcile that generation instead of creating a recursive return loop.",
      );
    if (
      db
        .prepare(
          "SELECT issue FROM scheduled_issues WHERE agent=? AND active=1 AND issue<>?",
        )
        .get(run.agent, run.issue)
    )
      return hold(
        "awaiting_worker_capacity",
        "The original worker is occupied by another issue. Keep its running or usage-paused session; retry eligibility after its result.",
      );
    const owner = config.agents[run.agent];
    const assignment = post(
      run.issue,
      "cloud-assignment",
      `### Task for ${owner.name}\n\nContinue this exact issue in its existing cloud chat. This is a same-chat queued return, not a new run and not proof that the prior turn ended. Read the original assignment, current approved PLAN.md and docs/initiative-decisions.md, and the bound investigation above. ` +
        (preparation
          ? "Prepare only the qualification artifact using known facts, explicit unknowns and an owner/partner checklist. Keep all data synthetic. The original live-pilot gate remains held; this preparation cannot accept it. "
          : "Complete the original outcome and acceptance criteria within the approved scope. ") +
        "Do not invent external access, permissions, spending or facts. Preserve the current branch/checkpoint and use an isolated worktree for changes. " +
        `Include Vizor return: ${run.id} on its own line in every result. ` +
        (task.gate === "merge"
          ? `Put Vizor issue: #${run.issue} on its own line in the PR body; report Vizor result: done (PR #NUMBER). `
          : "Publish the artifact and report Vizor result: done on its own line. ") +
        "If blocked, report Vizor result: blocked; add Vizor blocker: capacity for a usage pause or Vizor blocker: external for missing authority. Keep this same chat through usage pauses. End this turn after reporting.",
    );
    if (
      !Number.isSafeInteger(assignment.id) ||
      BigInt(assignment.id) <= BigInt(run.comment)
    )
      throw Error("Invalid return assignment comment.");
    const at = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO cloud_returns(run,issue,agent,original_assignment,assignment,session,state,preparation,detail,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'prepared',?,?,?,?)`,
      ).run(
        run.id,
        run.issue,
        run.agent,
        run.assignment,
        String(assignment.id),
        session,
        Number(preparation),
        "Same-chat return prepared; provider delivery not yet attempted.",
        at,
        at,
      );
      if (
        !db
          .prepare(
            "UPDATE scheduled_issues SET assignment=?,active=1,result=NULL,pull=NULL,accepted=0 WHERE issue=? AND agent=? AND assignment=?",
          )
          .run(String(assignment.id), run.issue, run.agent, run.assignment)
          .changes
      )
        throw Error("Worker claim changed.");
      db.prepare(
        "UPDATE assignments SET comment=? WHERE issue=? AND agent=?",
      ).run(
        `https://github.com/${config.repository}/issues/${run.issue}#issuecomment-${assignment.id}`,
        run.issue,
        run.agent,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    record = db.prepare("SELECT * FROM cloud_returns WHERE run=?").get(run.id);
    activity(
      db,
      run.id,
      "cloud_prepared",
      "Reserved the original worker and a new result generation in the exact existing chat. Original assignment and Fire receipt retained.",
    );
  }
  const current = db
    .prepare("SELECT * FROM scheduled_issues WHERE issue=?")
    .get(run.issue);
  const currentReceipt = db
    .prepare("SELECT * FROM deliveries WHERE issue=?")
    .get(run.issue);
  if (
    current.agent !== record.agent ||
    current.assignment !== record.assignment ||
    !current.active ||
    cloudSession(currentReceipt?.session) !== record.session ||
    currentReceipt?.state !== "started"
  )
    return hold(
      "cloud_binding_required",
      "Saved assignment or provider session changed before send; reconcile this generation without starting another chat.",
    );
  // This reservation survives a lost response or process crash. Only a prepared,
  // never-attempted message can be sent; no automatic retries after sending.
  if (
    !db
      .prepare(
        "UPDATE cloud_returns SET state='sending',updated_at=? WHERE run=? AND state='prepared'",
      )
      .run(new Date().toISOString(), run.id).changes
  )
    return;
  db.prepare("UPDATE blocker_runs SET state='cloud_sending' WHERE id=?").run(
    run.id,
  );
  activity(
    db,
    run.id,
    "cloud_sending",
    "Sending one queued return through the supported CLI; never falling back to Fire.",
  );
  let outcome;
  try {
    outcome = send({
      executable: provider.executable,
      session: record.session,
      text: `Vizor same-chat return for ${config.repository}#${run.issue}. Read the trusted continuation assignment at https://github.com/${config.repository}/issues/${run.issue}#issuecomment-${record.assignment}. Verify its author, repository and exact heading before acting. Return token: ${run.id}. This only queues the authorized continuation within this existing chat; do not create another session or pick up another task.`,
    });
  } catch {
    outcome = {
      state: "uncertain",
      detail:
        "Provider response lost; inspect the original cloud chat for the return token. Do not resend or Fire.",
    };
  }
  db.prepare(
    "UPDATE cloud_returns SET state=?,detail=?,updated_at=? WHERE run=?",
  ).run(outcome.state, outcome.detail, new Date().toISOString(), run.id);
  hold("cloud_" + outcome.state, outcome.detail);
}

export function cloudReturnSnapshot(db) {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE name='cloud_returns'")
      .get()
  )
    return [];
  return db
    .prepare(
      "SELECT run,issue,agent,assignment,session,state,preparation,result_comment,detail,updated_at FROM cloud_returns ORDER BY created_at DESC",
    )
    .all();
}
