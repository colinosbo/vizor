const tabs = [...document.querySelectorAll('[role="tab"]')];
const activity = document.querySelector("#activity");
const decision = document.querySelector("#decision");
const notice = document.querySelector("#notice");
const status = document.querySelector("#connection");
let renderedDecision = "";
let pending = false;
let refreshAgain = false;
let presetProfiles = {};
const selectedProjectId =
  new URL(location.href).searchParams.get("project") ?? "default";
let latestState = null;
function projectUrl(path) {
  return `${path}?project=${encodeURIComponent(selectedProjectId)}`;
}
const lines = (value) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const selectedValues = (select) =>
  [...select.selectedOptions].map((option) => option.value).filter(Boolean);
function options(select, values) {
  const signature = JSON.stringify(values);
  if (select.dataset.options === signature) return;
  const selected = new Set(selectedValues(select));
  select.replaceChildren(
    ...values.map(({ id, name }) => {
      const option = node("option", name);
      option.value = id;
      option.selected = selected.has(id);
      return option;
    }),
  );
  select.dataset.options = signature;
}
function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value != null) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function link(url, label) {
  const element = node("a", label);
  element.href = url;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  return element;
}
function alert(message) {
  notice.hidden = !message;
  notice.textContent = message;
}
async function saveAgentAction(path, input) {
  const response = await fetch(projectUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = Error(result.error || "Could not save the change.");
    error.status = response.status;
    throw error;
  }
  void refresh();
  return result;
}
const agentForm = document.getElementById("agent-form");
function showPresetSkills() {
  const profile = presetProfiles[agentForm.elements.preset.value];
  document.getElementById("preset-skills").textContent = profile
    ? `Included skills · ${profile.skills.map((skill) => skill.name).join(" · ")}`
    : "";
}
agentForm.elements.preset.addEventListener("change", showPresetSkills);
agentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = agentForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  alert("");
  try {
    const result = await saveAgentAction(
      "/dashboard/agents",
      Object.fromEntries(new FormData(agentForm)),
    );
    document.getElementById("agent-settings").value = [
      `VIZOR_RUNNER_AGENT_ID=${result.agent.id}`,
      `VIZOR_RUNNER_PROJECT_ID=${selectedProjectId}`,
      `VIZOR_RUNNER_PAIRING_KEY=${result.key}`,
      `VIZOR_RUNNER_RELAY=${location.origin}`,
      "VIZOR_RUNNER_REPO=<full path to this agent's dedicated checkout>",
      "",
      "Sign in with npm run runner -- --login, then start npm run runner.",
    ].join("\n");
    document.getElementById("agent-connection").hidden = false;
    agentForm.reset();
    showPresetSkills();
  } catch (error) {
    alert(error.message);
    submit.disabled = false;
  }
});
document
  .getElementById("project-picker")
  .addEventListener("change", (event) => {
    location.assign(`?project=${encodeURIComponent(event.target.value)}#tasks`);
  });
const projectForm = document.getElementById("project-form");
let projectAttempt = { signature: "", id: "" };
projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = projectForm.querySelector("button");
  button.disabled = true;
  alert("");
  try {
    const data = Object.fromEntries(new FormData(projectForm));
    const input = {
      name: data.name,
      goal: data.goal,
      ...(String(data.documentContent).trim()
        ? {
            document: {
              name: data.documentName,
              content: data.documentContent,
            },
          }
        : {}),
      repository: data.repository,
      paths: lines(data.paths),
      managerId: data.managerId,
      agentIds: [
        ...new Set([
          ...selectedValues(projectForm.elements.agentIds),
          data.managerId,
        ]),
      ],
    };
    const signature = JSON.stringify(input);
    if (projectAttempt.signature !== signature)
      projectAttempt = { signature, id: crypto.randomUUID() };
    const result = await saveAgentAction("/dashboard/projects", {
      ...input,
      requestId: projectAttempt.id,
    });
    location.assign(`?project=${result.project.id}#tasks`);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
});
const memberForm = document.getElementById("member-form");
const documentForm = document.getElementById("document-form");
function bindDocumentUpload(id, form, nameField, contentField) {
  document.getElementById(id).addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (!/\.(md|txt)$/i.test(file.name) || file.size > 120000)
        throw Error(
          "Choose a Markdown or text file of at most 20,000 characters.",
        );
      const content = await file.text();
      if (!content.trim() || content.length > 20000 || content.includes("\0"))
        throw Error("The document must contain text, up to 20,000 characters.");
      form.elements[nameField].value = file.name.slice(0, 160);
      form.elements[contentField].value = content;
      form.dataset.dirty = "true";
      alert("");
    } catch (error) {
      alert(error.message);
      event.target.value = "";
    }
  });
}
bindDocumentUpload(
  "new-document-file",
  projectForm,
  "documentName",
  "documentContent",
);
bindDocumentUpload("project-document-file", documentForm, "name", "content");
documentForm.addEventListener("input", () => {
  documentForm.dataset.dirty = "true";
});
let documentAttempt = { signature: "", id: "" };
documentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = documentForm.querySelector("button");
  button.disabled = true;
  try {
    const input = {
      name: documentForm.elements.name.value,
      content: documentForm.elements.content.value,
    };
    const signature = JSON.stringify(input);
    if (signature !== documentAttempt.signature)
      documentAttempt = { signature, id: crypto.randomUUID() };
    await saveAgentAction("/dashboard/document", {
      requestId: documentAttempt.id,
      document: input,
    });
    delete documentForm.dataset.dirty;
    alert(
      "Document saved. The selected manager will plan and assign tasks when its runner is connected.",
    );
    void refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});
memberForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = memberForm.querySelector("button");
  button.disabled = true;
  try {
    await saveAgentAction("/dashboard/members", {
      agentIds: selectedValues(memberForm.elements.agentIds),
    });
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});
const taskForm = document.getElementById("task-form");
let taskAttempt = null;
let taskSubmitting = false;
taskForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (taskSubmitting) return;
  taskSubmitting = true;
  const button = taskForm.querySelector("button");
  button.disabled = true;
  alert("");
  try {
    const data = Object.fromEntries(new FormData(taskForm));
    const input = {
      title: data.title,
      description: data.description,
      acceptance: data.acceptance,
      paths: selectedValues(taskForm.elements.paths),
      dependencies: selectedValues(taskForm.elements.dependencies),
      references: lines(data.references),
      checks: selectedValues(taskForm.elements.checks),
    };
    const signature = JSON.stringify(input);
    if (taskAttempt?.signature !== signature)
      taskAttempt = {
        signature,
        id: crypto.randomUUID(),
        basis: latestState.latest.id,
      };
    await saveAgentAction("/dashboard/project", {
      id: taskAttempt.id,
      action: { kind: "task_create", basis: taskAttempt.basis, ...input },
    });
    taskForm.reset();
    taskAttempt = null;
  } catch (error) {
    alert(error.message);
    if (error.status === 409) {
      taskAttempt = null;
      void refresh();
    }
  } finally {
    taskSubmitting = false;
    button.disabled = !latestState?.plan || latestState.completed;
  }
});
document.getElementById("task-filter").addEventListener("change", () => {
  if (latestState) renderQueue(latestState);
});
document.getElementById("dismiss-agent-key").addEventListener("click", () => {
  document.getElementById("agent-settings").value = "";
  document.getElementById("agent-connection").hidden = true;
  agentForm.querySelector('button[type="submit"]').disabled = false;
});
function agentButton(label, path, agentId, disabled) {
  const button = node("button", label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", async () => {
    button.disabled = true;
    alert("");
    try {
      await saveAgentAction(path, { agentId });
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = disabled;
    }
  });
  return button;
}
function selectTab(view, focus = false) {
  const selected = tabs.find((tab) => tab.dataset.view === view) ?? tabs[0];
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.dataset.view).hidden = !active;
  }
  if (focus) selected.focus();
}
function openTab(tab) {
  if (location.hash !== `#${tab.dataset.view}`)
    history.pushState(null, "", `#${tab.dataset.view}`);
  selectTab(tab.dataset.view, true);
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => openTab(tab));
  tab.addEventListener("keydown", (event) => {
    const target = {
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    openTab(tabs[target]);
  });
});
function restoreTab() {
  selectTab(location.hash.slice(1));
}
window.addEventListener("hashchange", restoreTab);
restoreTab();

const issueFilters = [...document.querySelectorAll("[data-issues]")];
for (const button of issueFilters) {
  button.addEventListener("click", () => {
    for (const filter of issueFilters)
      filter.setAttribute("aria-pressed", String(filter === button));
    document.getElementById("findings-section").hidden =
      button.dataset.issues === "github";
    document.getElementById("github-issues-section").hidden =
      button.dataset.issues === "findings";
  });
}

function renderDecision(state) {
  const setup = !state.plan && !state.draft && !state.decision;
  const current =
    state.decision ??
    state.draft ??
    (setup ? { id: "initial", kind: "draft", text: "" } : null);
  if (renderedDecision === (current?.id ?? "")) return;
  renderedDecision = current?.id ?? "";
  decision.hidden = !current;
  decision.replaceChildren();
  if (!current) return;
  const form = node("form");
  const isDraft = current.kind === "draft";
  if (setup) {
    const details = node("details");
    details.append(node("summary", "Set project scope"), form);
    decision.append(details);
  } else {
    decision.append(
      node("h2", isDraft ? "Approve project scope" : "Decision needed"),
      form,
    );
  }
  if (!isDraft) form.append(node("p", current.text));
  const label = node("label", isDraft ? "Goal and scope" : "Your direction");
  const answer = node("textarea");
  answer.required = true;
  answer.rows = isDraft ? 5 : 3;
  answer.maxLength = isDraft ? 8000 : 4000;
  answer.value = isDraft ? current.text : "";
  label.append(answer);
  form.append(label);
  const scope = node("textarea");
  if (isDraft) {
    const label = node(
      "label",
      "Approved project-relative files, one per line",
    );
    scope.rows = 3;
    scope.value = (current.paths ?? []).join("\n");
    label.append(scope);
    form.append(label);
  }
  const send = node(
    "button",
    setup
      ? "Approve scope for future findings"
      : isDraft
        ? "Approve and start"
        : "Send decision",
  );
  form.append(send);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    send.disabled = true;
    alert("");
    try {
      const response = await fetch(projectUrl("/dashboard/project"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          action: isDraft
            ? {
                kind: "approve",
                ...(setup ? { waitForReview: true } : { draftId: current.id }),
                text: answer.value,
                paths: scope.value
                  .split(/\r?\n/)
                  .map((path) => path.trim())
                  .filter(Boolean),
              }
            : { kind: "answer", decisionId: current.id, text: answer.value },
        }),
      });
      if (!response.ok)
        throw Error(
          (await response.json()).error || "Could not save decision.",
        );
      void refresh();
    } catch (error) {
      alert(error.message);
    } finally {
      send.disabled = false;
    }
  });
}

const eventNames = {
  task_create: "Task created",
  project_document: "Project document approved for planning",
  task_accept: "Task accepted",
  task_retry: "Task returned to queue",
  work_start: "Worker started task",
  usage_wait: "Waiting for subscription usage",
  publish_approve: "PR publication approved",
  publish_wait: "PR publication waiting to retry",
  review: "PR review",
  assign: "Orchestrator assigned work",
  claim: "Worker acknowledged task",
  reply: "Orchestrator replied",
  complete: "Project complete",
  stop: "Project stopped",
};
function eventName(event) {
  if (event.kind === "assign" && event.source === "backup")
    return "Assigned to backup after acknowledgement timeout";
  if (event.kind === "assign" && event.source === "github")
    return "GitHub dispatched work";
  return event.kind === "report"
    ? event.needsReply
      ? "Worker question"
      : "Worker report"
    : eventNames[event.kind];
}
function renderRows(element, children, empty) {
  if (!children.length) children = [node("p", empty, "empty")];
  if (
    element.childElementCount === children.length &&
    children.every((child, index) => child.isEqualNode(element.children[index]))
  )
    return;
  element.replaceChildren(...children);
}
function setCount(id, value) {
  const count = document.getElementById(id);
  count.hidden = value == null;
  count.textContent = value ?? "";
}
function time(value) {
  const date = new Date(
    value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
  );
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  });
  const element = node(
    "time",
    days === 0 ? "Today" : days === 1 ? "Yesterday" : formatted.format(date),
    "time",
  );
  element.dateTime = date.toISOString();
  element.title = date.toLocaleString();
  return element;
}
function badge(text, tone = "") {
  return node("span", text, `badge ${tone}`.trim());
}
function metric(value, label, emphasized = false) {
  const card = node(
    "div",
    "",
    emphasized ? "metric surface attention" : "metric surface",
  );
  card.append(node("strong", value ?? "—"), node("span", label));
  return card;
}
function repositoryRow(base, item, kind) {
  const row = node("article", "", "row");
  const heading = node("h3");
  heading.append(
    node("span", `#${item.number}`, "number"),
    link(
      `${base}/${kind === "issue" ? "issues" : "pull"}/${item.number}`,
      item.title,
    ),
  );
  const meta = node("div", "", "row-meta");
  meta.append(
    badge(
      kind === "merged" ? "Merged" : "Open",
      kind === "merged" ? "merged" : "open",
    ),
  );
  meta.append(...item.labels.map((label) => badge(label)));
  row.append(heading, meta, time(item.mergedAt ?? item.updatedAt));
  return row;
}
function taskAction(label, kind, taskId) {
  const button = node("button", label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    alert("");
    try {
      await saveAgentAction("/dashboard/project", {
        id: crypto.randomUUID(),
        action: {
          kind,
          taskId,
          basis: latestState.latest.id,
          text:
            kind === "task_accept"
              ? "Accepted by the project owner."
              : "Retry requested by the project owner.",
        },
      });
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
function publicationButton(task) {
  const button = node("button", "Approve this commit and publish PR");
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    alert("");
    try {
      const thread = latestState.tasks.find(
        (thread) => thread.task.id === task.executionId,
      );
      if (!thread) throw Error("This handoff is no longer active.");
      await saveAgentAction("/dashboard/project", {
        id: crypto.randomUUID(),
        action: {
          kind: "publish_approve",
          basis: latestState.latest.id,
          turnId: thread.turn.id,
          head: task.handoff.head,
        },
      });
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
function replyToWorker(turnId) {
  const form = node("form");
  const label = node("label", "Answer worker question");
  const answer = node("textarea");
  answer.required = true;
  answer.maxLength = 6000;
  answer.rows = 3;
  label.append(answer);
  const submit = node("button", "Send answer");
  submit.type = "submit";
  form.append(label, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!answer.value.trim()) return;
    submit.disabled = true;
    alert("");
    try {
      await saveAgentAction("/dashboard/project", {
        id: crypto.randomUUID(),
        action: {
          kind: "reply",
          basis: latestState.latest.id,
          turnId,
          text: answer.value.trim(),
        },
      });
    } catch (error) {
      alert(error.message);
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}
function renderQueue(state) {
  const container = document.getElementById("task-queue");
  const expanded = new Set(
    [...container.querySelectorAll("details[open]")].map(
      (details) => details.dataset.task,
    ),
  );
  const filter = document.getElementById("task-filter").value;
  const queue = state.queue ?? [];
  setCount(
    "tasks-count",
    queue.filter((task) => task.status !== "complete").length,
  );
  renderRows(
    container,
    queue
      .filter((task) => filter === "all" || task.status === filter)
      .map((task) => {
        const row = node("article", "", "row queued-task");
        const question = state.tasks.find(
          (thread) =>
            thread.task.id === task.executionId &&
            thread.turn.kind === "report" &&
            thread.turn.needsReply,
        )?.turn;
        const heading = node("div", "", "section-bar");
        heading.append(
          node("h3", task.title),
          badge(
            task.retryAt
              ? "Waiting for subscription usage"
              : question
                ? "Needs answer"
                : task.handoff &&
                    !task.handoff.prUrl &&
                    !task.publicationApproved
                  ? "Publication approval needed"
                  : task.status === "review"
                    ? "Ready for review"
                    : task.status,
            task.status === "complete" ? "open" : "agent",
          ),
        );
        const assignee = state.agents?.find(
          (agent) => agent.id === task.assignee,
        );
        const dependencies = task.dependencies
          .map((id) => queue.find((item) => item.id === id))
          .filter(Boolean);
        row.append(
          heading,
          node(
            "p",
            assignee ? `Assigned to ${assignee.name}` : "Unassigned",
            "meta",
          ),
          node("p", task.description),
        );
        if (task.ackDeadline)
          row.append(
            node(
              "p",
              "Primary acknowledgement due: " +
                new Date(task.ackDeadline).toLocaleString(),
              "meta",
            ),
          );
        if (task.retryAt)
          row.append(
            node(
              "p",
              "Next attempt: " + new Date(task.retryAt).toLocaleString(),
              "meta",
            ),
          );
        if (dependencies.length)
          row.append(
            node(
              "p",
              `Depends on · ${dependencies.map((item) => `${item.title} (${item.status})`).join(" · ")}`,
              "meta",
            ),
          );
        const details = node("details");
        details.dataset.task = task.id;
        details.open = Boolean(question) || expanded.has(task.id);
        details.append(
          node("summary", "Task details"),
          node("h4", "Acceptance criteria"),
          node("p", task.acceptance),
          node(
            "p",
            `Approved scope · ${task.paths.join(", ") || "Read-only"}`,
            "meta",
          ),
        );
        for (const reference of task.references)
          details.append(link(reference, reference));
        if (task.summary)
          details.append(node("h4", "Latest report"), node("p", task.summary));
        if (task.handoff) {
          details.append(
            node("h4", "PR handoff"),
            node(
              "p",
              `${task.handoff.repository} · ${task.handoff.branch} → ${task.handoff.base}`,
              "meta",
            ),
            node("p", `Commit ${task.handoff.head}`, "meta"),
          );
          for (const check of task.handoff.checks)
            details.append(node("p", check, "meta"));
          if (task.handoff.prUrl)
            row.append(link(task.handoff.prUrl, "Open pull request"));
          else {
            details.open = true;
            row.append(
              node(
                "p",
                task.publicationApproved
                  ? "Publication approved. The worker will resume or retry this exact commit."
                  : "Approve publication of the repository, branch and commit shown below. Publishing may activate repository automation.",
                "meta",
              ),
            );
          }
        }
        row.append(details);
        if (question && !state.decision) row.append(replyToWorker(question.id));
        const controls = node("div", "", "runner-actions");
        if (task.handoff && !task.handoff.prUrl && !task.publicationApproved)
          controls.append(publicationButton(task));
        if (task.status === "review" && (!task.handoff || task.handoff.prUrl))
          controls.append(taskAction("Accept result", "task_accept", task.id));
        if (
          task.status === "blocked" &&
          !state.tasks.some((thread) => thread.task.id === task.executionId)
        )
          controls.append(taskAction("Return to queue", "task_retry", task.id));
        row.append(controls);
        return row;
      }),
    filter === "all"
      ? "No tasks yet. The Orchestrator can plan tasks from the approved project goal."
      : "No tasks with this status.",
  );
}
function renderDashboard(state) {
  presetProfiles = state.presets ?? {};
  showPresetSkills();
  options(document.getElementById("project-picker"), state.projects ?? []);
  document.getElementById("project-picker").value = selectedProjectId;
  document.getElementById("runner-project-id").value = selectedProjectId;
  const availableAgents = state.availableAgents ?? state.agents ?? [];
  options(
    projectForm.elements.managerId,
    availableAgents.filter((agent) => agent.preset === "orchestrator"),
  );
  options(projectForm.elements.agentIds, availableAgents);
  options(
    memberForm.elements.agentIds,
    availableAgents.filter(
      (agent) => !state.agents.some((member) => member.id === agent.id),
    ),
  );
  options(taskForm.elements.paths, [
    { id: "", name: "Read-only · no source file" },
    ...(state.plan?.paths ?? []).map((path) => ({ id: path, name: path })),
  ]);
  options(
    taskForm.elements.dependencies,
    (state.queue ?? []).map((task) => ({ id: task.id, name: task.title })),
  );
  taskForm.querySelector("button").disabled =
    taskSubmitting || !state.plan || state.completed;
  const project = state.project;
  const savedDocument = project?.document;
  const signature = JSON.stringify(savedDocument ?? null);
  if (!documentForm.dataset.dirty && documentForm.dataset.saved !== signature) {
    documentForm.elements.name.value = savedDocument?.name ?? "Project brief";
    documentForm.elements.content.value = savedDocument?.content ?? "";
    documentForm.dataset.saved = signature;
  }
  const manager = state.agents?.find((agent) => agent.id === state.managerId);
  document.getElementById("document-status").textContent = savedDocument
    ? `${savedDocument.name} · ${manager?.online ? "Manager connected" : "Waiting for the manager runner to connect"}`
    : "Add a brief for the manager to plan from.";
  documentForm.querySelector("button").disabled =
    !state.plan || Boolean(state.decision);
  const summary = document.getElementById("project-summary");
  summary.replaceChildren(
    node("h2", project?.name ?? "BlackForge"),
    node(
      "p",
      project?.goal ||
        state.plan?.text ||
        "Approve a goal and let the Orchestrator plan the work.",
      "muted",
    ),
  );
  if (project?.repository) {
    const repositoryLink = document.querySelector(".subtitle a");
    repositoryLink.href = `https://github.com/${project.repository}`;
    repositoryLink.textContent = project.repository;
    document.title = `${project.name} · Vizor`;
  }
  renderQueue(state);
  const repo = state.repository;
  const base = repo ? `https://github.com/${repo.repository}` : "";
  const events = state.events.filter(eventName).reverse();
  const tasks =
    state.tasks ??
    (state.task
      ? [{ task: state.task, turn: state.turn, claim: state.claim }]
      : []);
  const waiting = tasks.filter(
    (thread) => thread.turn?.kind === "report" && thread.turn.needsReply,
  ).length;
  const needsYou =
    (state.decision || state.draft ? 1 : 0) +
    (state.queue ?? []).filter(
      (task) =>
        task.handoff && !task.handoff.prUrl && !task.publicationApproved,
    ).length;
  const working = state.queue
    ? state.queue.filter((task) => task.status === "working").length
    : tasks.filter((thread) => thread.claim && thread.turn?.kind !== "report")
        .length;
  const open = repo?.pulls?.length;
  const issueCount = repo?.issues?.length;
  setCount("issues-count", issueCount === 50 ? "50+" : issueCount);
  setCount("prs-count", open === 50 ? "50+" : open);
  const registered = (state.agents ?? []).filter((agent) => !agent.revoked);
  setCount("agents-count", registered.length || state.connectedRoles.length);
  document
    .getElementById("metrics")
    .replaceChildren(
      metric(needsYou, "Needs you", needsYou > 0),
      metric(working, "Working"),
      metric(open === 50 ? "50+" : open, "PRs open"),
      metric(waiting, "Waiting on reply"),
      metric(state.findings.length, "Review findings"),
    );
  const liveTitle = document.getElementById("live-title");
  const liveRows = document.getElementById("live-rows");
  const livePulls = repo?.pulls?.slice(0, 3) ?? [];
  const recentPulls = livePulls.length
    ? livePulls
    : (repo?.merged?.slice(0, events.length ? 2 : 3) ?? []);
  liveTitle.textContent = open
    ? `${state.connectedRoles.includes("owner") ? "Live" : "Latest sync"} · ${open === 50 ? "50+" : open} open ${open === 1 ? "pull request" : "pull requests"}`
    : "Quiet · Latest activity";
  const preview = recentPulls.map((item) => {
    const row = node("div", "", "live-row");
    row.append(
      badge(
        item.mergedAt ? "Merged" : "Open PR",
        item.mergedAt ? "merged" : "open",
      ),
      link(`${base}/pull/${item.number}`, `#${item.number} ${item.title}`),
      time(item.mergedAt ?? item.updatedAt),
    );
    return row;
  });
  if (events[0] && preview.length < 3) {
    const row = node("div", "", "live-row");
    const actor = state.agents?.find((agent) => agent.id === events[0].actorId);
    row.append(
      badge("Agent", "agent"),
      node(
        "span",
        [eventName(events[0]), actor?.name].filter(Boolean).join(" · "),
      ),
      time(events[0].created),
    );
    preview.unshift(row);
  }
  renderRows(liveRows, preview, "No project activity yet.");

  const unavailable = "Waiting for GitHub sync from the owner runner.";
  for (const [id, items, kind, empty] of [
    ["github-issues", repo?.issues, "issue", "No open GitHub issues."],
    ["open-prs", repo?.pulls, "pull", "No open pull requests."],
    ["merged-prs", repo?.merged, "merged", "No recently merged pull requests."],
  ]) {
    renderRows(
      document.getElementById(id),
      items?.map((item) => repositoryRow(base, item, kind)) ?? [],
      items == null ? unavailable : empty,
    );
  }
  document.getElementById("findings-count").textContent = state.findings.length;
  renderRows(
    document.getElementById("findings"),
    state.findings.map((finding) => {
      const item = node("article", "", "row finding");
      const meta = node("p", "", "meta");
      const repo = `https://github.com/${finding.repository}`;
      const file = finding.file.split("/").map(encodeURIComponent).join("/");
      meta.append(
        link(`${repo}/pull/${finding.number}`, `PR #${finding.number}`),
        " · ",
        link(
          `${repo}/blob/${finding.head}/${file}#L${finding.line}`,
          `${finding.file}:${finding.line}`,
        ),
      );
      item.append(
        node("h3", finding.title),
        meta,
        node("p", finding.impact),
        node("p", `Fix · ${finding.fix}`),
      );
      return item;
    }),
    "No production findings in the queue.",
  );
  if (registered.length) {
    renderRows(
      document.getElementById("runners"),
      registered.map((agent) => {
        const selected = state.managerId === agent.id;
        const card = node("article", "", "runner surface");
        card.append(
          node("h3", agent.name),
          badge(
            agent.online ? "Connected" : "Offline",
            agent.online ? "open" : "",
          ),
          node(
            "p",
            `${agent.participant} · ${presetProfiles[agent.preset]?.name ?? agent.preset}${selected ? " · Project Orchestrator" : ""}`,
            "meta",
          ),
          node("p", agent.skills.join(" · "), "meta"),
        );
        const assigned = tasks.find(
          (thread) => thread.task.agentId === agent.id,
        );
        if (assigned)
          card.append(
            node("p", `Assigned · ${assigned.task.text.slice(0, 180)}`, "meta"),
          );
        if (agent.instructions)
          card.append(node("p", agent.instructions, "meta"));
        const actions = node("div", "", "runner-actions");
        const busy = Boolean(
          assigned || (selected && (state.task || state.decision)),
        );
        if (agent.preset === "orchestrator")
          actions.append(
            agentButton(
              selected ? "Selected Orchestrator" : "Use as Orchestrator",
              "/dashboard/manager",
              agent.id,
              selected,
            ),
          );
        actions.append(
          agentButton(
            "Remove from project",
            "/dashboard/remove-member",
            agent.id,
            Boolean(assigned || selected),
          ),
          agentButton(
            "Revoke connection",
            "/dashboard/revoke-agent",
            agent.id,
            busy,
          ),
        );
        card.append(actions);
        return card;
      }),
      "No registered agents yet.",
    );
  } else
    document.getElementById("runners").replaceChildren(
      ...[
        ["owner", "Orchestrator"],
        ["worker", "Worker"],
      ].map(([role, name]) => {
        const online = state.connectedRoles.includes(role);
        const card = node("div", "", "runner surface");
        card.append(
          node("h3", name),
          badge(online ? "Connected" : "Offline", online ? "open" : ""),
        );
        return card;
      }),
    );
  renderRows(
    activity,
    events.slice(0, 20).map((event) => {
      const item = node("article", "", "row");
      const actor = state.agents?.find((agent) => agent.id === event.actorId);
      const target = state.agents?.find((agent) => agent.id === event.agentId);
      item.append(
        node("h3", eventName(event)),
        node(
          "p",
          [actor?.name, target && `Assigned to ${target.name}`]
            .filter(Boolean)
            .join(" · "),
          "meta",
        ),
        node("p", event.text),
        time(event.created),
      );
      return item;
    }),
    "Agent updates will appear here.",
  );
}
async function refresh() {
  if (pending) {
    refreshAgain = true;
    return;
  }
  pending = true;
  try {
    const response = await fetch(projectUrl("/dashboard/project"), {
      cache: "no-store",
    });
    if (!response.ok) throw Error();
    const state = await response.json();
    latestState = state;
    renderDecision(state);
    renderDashboard(state);
    if (events.readyState === EventSource.OPEN)
      status.textContent = "Relay connected";
  } catch {
    status.textContent = "Unavailable";
  } finally {
    pending = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}
const events = new EventSource(projectUrl("/dashboard/events"));
events.onopen = () => {
  status.textContent = "Relay connected";
};
events.onmessage = () => void refresh();
events.onerror = () => {
  status.textContent = "Reconnecting";
};
void refresh();
