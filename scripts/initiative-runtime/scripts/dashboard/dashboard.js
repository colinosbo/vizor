const $ = (id) => document.getElementById(id);
const statusName = {
  running: "Running (observed)",
  started: "Start confirmed",
  unconfirmed: "Start unconfirmed",
  capacity: "Usage paused",
  ready: "Ready",
  blocked: "Blocked",
  waiting: "Waiting",
  review: "Review needed",
  checks: "PR / checks",
  complete: "Complete",
};
const attention = new Set([
  "blocked",
  "review",
  "checks",
  "unconfirmed",
  "capacity",
]);
let snapshot;
let filter = "remaining";

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function badge(text, status) {
  return node("span", text, "badge " + status);
}

function issueLink(number, text, kind = "issues") {
  const a = node("a", text);
  a.href =
    "https://github.com/" + snapshot.repository + "/" + kind + "/" + number;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function taskLink(task) {
  return issueLink(task.issue, "#" + task.issue + " " + task.title);
}

function renderAgents() {
  $("agents").replaceChildren(
    ...snapshot.agents.map(({ id, name }) => {
      const tasks = snapshot.tasks.filter((task) => task.agent === id);
      const current =
        tasks.find((task) => ["running", "started"].includes(task.status)) ??
        tasks.find((task) => task.status === "blocked" && task.receipt) ??
        tasks.find((task) => attention.has(task.status));
      const next =
        tasks.find((task) => task.status === "ready") ??
        tasks.find((task) => task.status === "waiting");
      const card = node("article", undefined, "agent");
      const title = node("div", undefined, "agent-head");
      title.append(
        node("h3", name),
        current
          ? badge(statusName[current.status], current.status)
          : badge("Idle", "waiting"),
      );
      const focus = node("p");
      focus.append(current ? taskLink(current) : "No active assignment");
      card.append(title, focus);
      if (current) card.append(node("p", current.reason, "detail"));
      const upcoming = node("p", undefined, "next");
      upcoming.append(
        node("strong", "Next "),
        next ? taskLink(next) : "No queued assignment",
      );
      card.append(upcoming);
      if (next) card.append(node("p", next.reason, "detail"));
      return card;
    }),
  );
}

function renderTasks() {
  const names = new Map(snapshot.agents.map(({ id, name }) => [id, name]));
  const tasks = snapshot.tasks.filter(
    (task) =>
      filter === "all" ||
      (filter === "attention"
        ? attention.has(task.status)
        : task.status !== "complete"),
  );
  if (!tasks.length) {
    const row = node("tr");
    const message = node(
      "td",
      filter === "attention"
        ? "No tasks need attention."
        : "No tasks in this view.",
    );
    message.colSpan = 4;
    row.append(message);
    $("tasks").replaceChildren(row);
    return;
  }
  $("tasks").replaceChildren(
    ...tasks.map((task) => {
      const row = node("tr");
      const issue = node("td");
      issue.append(
        node("span", "#" + task.issue, "number"),
        issueLink(task.issue, task.title),
      );
      const status = node("td");
      status.append(badge(statusName[task.status], task.status));
      const reason = node("td", task.reason);
      if (task.pull)
        reason.append(" ", issueLink(task.pull, "PR #" + task.pull, "pull"));
      row.append(issue, node("td", names.get(task.agent)), status, reason);
      return row;
    }),
  );
}

function renderBlockers() {
  const data = snapshot.blockers ?? { investigations: [], activity: [] };
  $("blocker-section").hidden = !data.investigations.length;
  $("blockers").replaceChildren(
    ...data.investigations.map((run) => {
      const card = node("article", undefined, "agent");
      card.append(
        issueLink(run.issue, "#" + run.issue),
        node("p", "Orchestrator: " + run.state.replaceAll("_", " ")),
      );
      if (run.decision) {
        try {
          const decision = JSON.parse(run.decision);
          card.append(
            node("p", decision.summary),
            node("p", "Next: " + decision.nextStep),
          );
        } catch {
          /* Preserve the rest of the dashboard if an old report cannot be read. */
        }
      }
      if (run.session)
        card.append(node("p", "Saved Codex session: " + run.session, "detail"));
      if (run.successor)
        card.append(
          issueLink(run.successor, "Linked follow-up #" + run.successor),
        );
      const observation = snapshot.blockers?.providerObservations?.find(
        (item) => item.issue === run.issue,
      );
      if (observation)
        card.append(
          node(
            "p",
            "Provider snapshot " +
              (observation.observed_at
                ? "at " + new Date(observation.observed_at).toLocaleString()
                : "pending") +
              ": " +
              observation.state +
              " · " +
              observation.detail,
            "detail",
          ),
        );
      const returned = snapshot.blockers?.cloudReturns?.find(
        (item) => item.run === run.id,
      );
      if (returned)
        card.append(
          node(
            "p",
            "Same cloud chat: " + returned.state + " · " + returned.detail,
            "detail",
          ),
        );
      return card;
    }),
  );
  $("blocker-activity").replaceChildren(
    ...data.activity.map((entry) =>
      node(
        "li",
        new Date(entry.at).toLocaleString() +
          " · #" +
          entry.issue +
          " · " +
          entry.action.replaceAll("_", " ") +
          ": " +
          entry.detail,
      ),
    ),
  );
}

async function update() {
  try {
    const response = await fetch("/api/queue", { cache: "no-store" });
    const data = await response.json();
    if (!data.snapshot) throw Error("unavailable");
    snapshot = data.snapshot;
    $("repository").textContent = snapshot.repository;
    $("repository").href = "https://github.com/" + snapshot.repository;
    $("queue-state").textContent = snapshot.paused
      ? "Queue paused"
      : "Queue enabled · " + snapshot.mode;
    $("queue-state").className =
      "badge " +
      (data.stale || snapshot.errors?.length
        ? "blocked"
        : snapshot.paused
          ? "paused"
          : "running");
    $("queue-state").textContent = data.stale
      ? "Scheduler stale / stopped"
      : snapshot.errors?.length
        ? "Scheduler holding"
        : snapshot.roundState === "syncing"
          ? "Scheduler syncing"
          : snapshot.paused
            ? "Queue paused"
            : "Queue enabled · " + snapshot.mode;
    $("updated").title =
      "Scheduler PID " +
      snapshot.pid +
      "; last GitHub sync " +
      (snapshot.lastSuccessfulGitHubSync ?? "none") +
      "; rate remaining " +
      (snapshot.rate?.remaining ?? "unknown");
    $("updated").textContent =
      "Updated " +
      new Date(snapshot.updatedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      }) +
      " · PID " +
      snapshot.pid +
      " · GitHub sync " +
      (snapshot.lastSuccessfulGitHubSync
        ? new Date(snapshot.lastSuccessfulGitHubSync).toLocaleTimeString()
        : "not yet") +
      " · budget " +
      (snapshot.rate?.remaining ?? "unknown") +
      " · round " +
      (snapshot.roundDurationMs ?? 0) +
      " ms";
    $("notice").textContent =
      "Scheduler snapshot is stale or its process is stopped. Check runtime health.";
    $("notice").textContent = snapshot.errors?.length
      ? snapshot.errors.join(" ")
      : data.stale
        ? "Scheduler snapshot is stale or its process is stopped. Check runtime health."
        : "";
    $("notice").hidden = !data.stale && !snapshot.errors?.length;
    // The approved plan's phase state, so an empty queue is never mistaken for idle work.
    $("plan").textContent = snapshot.plan
      ? "Approved plan " +
        (snapshot.plan.plan ?? "") +
        (snapshot.plan.phase ? " · phase " + snapshot.plan.phase : "") +
        " · " +
        snapshot.plan.state +
        ": " +
        snapshot.plan.detail
      : "";
    $("plan").hidden = !snapshot.plan;
    $("agent-section").hidden = false;
    $("task-section").hidden = false;
    renderAgents();
    renderTasks();
    renderBlockers();
  } catch {
    $("notice").textContent = snapshot
      ? "Live refresh failed. Showing the last successful snapshot."
      : "Scheduler snapshot is missing. Start the scheduler or check runtime health on this PC.";
    $("notice").hidden = false;
    $("queue-state").textContent = "Refresh unavailable";
    $("queue-state").className = "badge blocked";
  }
}
document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
    if (snapshot) renderTasks();
  });
});
await update();
setInterval(() => {
  if (!document.hidden) void update();
}, 60000);
