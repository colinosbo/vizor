import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { agentRegistry, registrationSchema } from "./agent-registry.mjs";
import { agentPresets } from "./agent-presets.mjs";
import {
  projectContext,
  currentProjectId,
  projectIdSchema,
  projectInput,
  projectDocument,
  projectStore,
} from "./project-store.mjs";
import { taskInput, taskBrief, taskQueue } from "./task-queue.mjs";
import { handoffSchema } from "./worker-handoff.mjs";
import { checkNames } from "./worker-handoff.mjs";
import {
  createArtifactConnector,
  artifactMembers,
} from "./artifact-connector.mjs";

const keyPattern = /^[a-f0-9]{64}$/;
if (process.argv.includes("--keys")) {
  console.log("VIZOR_SHARED_OWNER_KEY=" + randomBytes(32).toString("hex"));
  console.log("VIZOR_SHARED_WORKER_KEY=" + randomBytes(32).toString("hex"));
  process.exit(0);
}
const ownerKey = process.env.VIZOR_SHARED_OWNER_KEY ?? "";
const workerKey = process.env.VIZOR_SHARED_WORKER_KEY ?? "";
if (
  !keyPattern.test(ownerKey) ||
  !keyPattern.test(workerKey) ||
  ownerKey === workerKey
)
  throw Error("Set distinct 64-character hex owner and worker keys.");

const databasePath = process.env.VIZOR_SHARED_DB ?? "data/vizor-shared.db";
mkdirSync(dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS event (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    body TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS dashboard_findings (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dashboard_repository (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
`);
const projects = projectStore(database);
const registry = agentRegistry(database);

const id = z.string().uuid();
const text = (max) => z.string().trim().min(1).max(max);
const paths = z.array(text(240)).max(20);
const outcome = z.enum(["completed", "failed", "blocked"]);
const action = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("project_message"),
    text: text(4000),
    taskId: id.optional(),
  }),
  taskInput.extend({ kind: z.literal("task_create"), basis: id }),
  z.strictObject({
    kind: z.literal("task_accept"),
    basis: id,
    taskId: id,
    text: text(4000),
  }),
  z.strictObject({
    kind: z.literal("task_retry"),
    basis: id,
    taskId: id,
    text: text(1000),
    checks: z.array(checkNames).min(1).max(4).optional(),
  }),
  z.strictObject({ kind: z.literal("draft"), text: text(8000), paths }),
  z.strictObject({
    kind: z.literal("review"),
    text: text(8000),
    paths: paths.optional(),
  }),
  z.strictObject({
    kind: z.literal("approve"),
    text: text(8000),
    paths,
    draftId: id.optional(),
    waitForReview: z.literal(true).optional(),
  }),
  z.strictObject({
    kind: z.literal("assign"),
    basis: id,
    text: text(8000),
    paths,
    agentId: id.optional(),
    queuedTaskId: id.optional(),
  }),
  z.strictObject({
    kind: z.literal("reply"),
    basis: id,
    turnId: id,
    text: text(6000),
  }),
  z.strictObject({ kind: z.literal("claim"), turnId: id, runnerId: id }),
  z.strictObject({ kind: z.literal("work_start"), turnId: id, runnerId: id }),
  z.strictObject({
    kind: z.literal("publish_approve"),
    basis: id,
    turnId: id,
    head: z.string().regex(/^[a-f0-9]{40}$/),
  }),
  z.strictObject({
    kind: z.literal("usage_wait"),
    turnId: id,
    runnerId: id,
    retryAt: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal("publish_wait"),
    turnId: id,
    runnerId: id,
    text: text(500),
  }),
  z.strictObject({
    kind: z.literal("report"),
    turnId: id,
    runnerId: id,
    outcome,
    text: text(12000),
    needsReply: z.boolean(),
    handoff: handoffSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("decision"), basis: id, text: text(4000) }),
  z.strictObject({
    kind: z.literal("answer"),
    decisionId: id,
    text: text(4000),
  }),
  z.strictObject({ kind: z.literal("stop"), decisionId: id, text: text(4000) }),
  z.strictObject({ kind: z.literal("complete"), basis: id, text: text(4000) }),
]);
const requestSchema = z.strictObject({ id, action });
const readEvents = database.prepare(
  "SELECT id, role, body, created FROM event WHERE project_id = ? ORDER BY rowid",
);
const findEvent = database.prepare(
  "SELECT role, body, project_id FROM event WHERE id = ?",
);
const insert = database.prepare(
  "INSERT INTO event (id, role, body, project_id) VALUES (?, ?, ?, ?)",
);

function state() {
  const events = readEvents
    .all(currentProjectId())
    .map(({ body, ...row }) => ({ ...row, ...JSON.parse(body) }));
  let plan = null;
  let draft = null;
  const threads = new Map();
  let focused = null;
  let lastTurn = null;
  let decision = null;
  let completed = false;
  let assigned = 0;
  for (const event of events) {
    const thread = [...threads.values()].find(
      (item) => item.turn.id === event.turnId && item.active,
    );
    if (thread) event.taskId = thread.task.id;
    switch (event.kind) {
      case "draft":
        draft = event;
        break;
      case "approve":
        plan = event;
        draft = null;
        completed = false;
        assigned = 0;
        break;
      case "review":
      case "project_document":
      case "project_message":
        if (completed) {
          completed = false;
          assigned = 0;
        }
        break;
      case "assign":
        event.taskId = event.id;
        focused = {
          task: event,
          turn: event,
          claim: null,
          runnerId: null,
          replies: 0,
          active: true,
        };
        threads.set(event.id, focused);
        lastTurn = event;
        assigned++;
        break;
      case "reply":
      case "publish_approve":
        thread.turn = event;
        if (event.kind === "publish_approve")
          event.handoff = thread.task.handoff;
        thread.claim = null;
        thread.replies++;
        focused = thread;
        lastTurn = event;
        break;
      case "claim":
        thread.claim = event;
        thread.runnerId = event.runnerId;
        break;
      case "report":
        thread.active =
          event.needsReply || Boolean(event.handoff && !event.handoff.prUrl);
        if (event.handoff) thread.task.handoff = event.handoff;
        thread.turn = event;
        focused = thread;
        lastTurn = event;
        break;
      case "decision":
        decision = event;
        break;
      case "answer":
        decision = null;
        assigned = 0;
        for (const item of threads.values()) item.replies = 0;
        break;
      case "stop":
        decision = lastTurn = null;
        for (const item of threads.values()) item.active = false;
        completed = true;
        break;
      case "complete":
        completed = true;
        break;
    }
  }
  const tasks = [...threads.values()]
    .filter((item) => item.active)
    .map(({ active, ...item }) => item);
  const current =
    tasks.find((item) => item.task.id === focused?.task.id) ?? tasks[0];
  return {
    plan,
    draft,
    task: current?.task ?? null,
    turn: current?.turn ?? lastTurn,
    tasks,
    queue: taskQueue(events),
    decision,
    claim: current?.claim ?? null,
    runnerId: current?.runnerId ?? null,
    completed,
    assigned,
    replies: current?.replies ?? 0,
    latest:
      events.findLast(
        (event) =>
          !["claim", "work_start", "publish_wait", "usage_wait"].includes(
            event.kind,
          ),
      ) ?? null,
    events: events.slice(-100),
  };
}

function allowed(current, next, role, actor, githubDispatch) {
  if (actor?.revoked) return false;
  if (role === "worker") {
    const thread = current.tasks.find((item) => item.turn.id === next.turnId);
    if (!thread) return false;
    current = { ...current, ...thread };
    if (
      !current.task ||
      !["assign", "reply", "publish_approve"].includes(current.turn.kind) ||
      next.turnId !== current.turn.id
    )
      return false;
    if (current.task.agentId && current.task.agentId !== actor?.id)
      return false;
    if (actor && current.task.agentId !== actor.id) return false;
    if (
      next.handoff &&
      (next.handoff.repository.toLowerCase() !==
        projects.get().repository.toLowerCase() ||
        next.handoff.files.some((file) => !current.task.paths.includes(file)))
    )
      return false;
    if (
      next.handoff &&
      (actor?.preset === "reviewer" ||
        next.outcome !== "completed" ||
        next.needsReply)
    )
      return false;
    if (
      next.handoff?.prUrl &&
      (current.turn.kind !== "publish_approve" ||
        next.handoff.head !== current.task.handoff?.head)
    )
      return false;
    if (next.handoff?.prUrl) {
      const approved = { ...current.task.handoff },
        published = { ...next.handoff };
      delete approved.prUrl;
      delete published.prUrl;
      if (JSON.stringify(approved) !== JSON.stringify(published)) return false;
    }
    if (next.kind === "claim")
      return (
        !current.claim &&
        (!current.runnerId || next.runnerId === current.runnerId)
      );
    if (next.kind === "work_start") {
      const queued = current.queue.find(
        (task) => task.executionId === current.task.id,
      );
      return (
        current.claim?.runnerId === next.runnerId &&
        (!queued?.retryAt || Date.parse(queued.retryAt) <= Date.now())
      );
    }
    if (next.kind === "usage_wait") {
      const retryAt = Date.parse(next.retryAt);
      return (
        current.turn.kind !== "publish_approve" &&
        current.claim?.runnerId === next.runnerId &&
        retryAt > Date.now() &&
        retryAt <= Date.now() + (3 * 60 + 1) * 60 * 1000
      );
    }
    if (next.kind === "publish_wait")
      return (
        current.turn.kind === "publish_approve" &&
        current.claim?.runnerId === next.runnerId
      );
    return (
      next.kind === "report" &&
      current.claim?.runnerId === next.runnerId &&
      (!next.needsReply || next.outcome === "blocked")
    );
  }
  if (!actor && next.kind === "project_message")
    return (
      !next.taskId || current.queue.some((task) => task.id === next.taskId)
    );
  if (
    actor &&
    (registry.managerId() !== actor.id ||
      ["approve", "answer", "stop", "publish_approve"].includes(next.kind))
  )
    return false;
  if (
    !actor &&
    registry.managerId() &&
    !(githubDispatch && next.kind === "assign" && next.queuedTaskId) &&
    ![
      "approve",
      "answer",
      "stop",
      "task_create",
      "task_accept",
      "task_retry",
      "publish_approve",
    ].includes(next.kind)
  )
    return false;
  if (next.kind === "approve")
    return (
      !current.task &&
      !current.decision &&
      (!next.draftId || current.draft?.id === next.draftId)
    );
  if (next.kind === "review")
    return (
      !!current.plan &&
      !current.task &&
      !current.decision &&
      !current.draft &&
      (!current.completed ||
        (current.latest?.kind === "complete" &&
          next.paths?.length > 0 &&
          next.paths.every((path) => current.plan.paths.includes(path)))) &&
      current.latest?.kind !== "review"
    );
  if (next.kind === "draft")
    return (
      !current.task &&
      !current.decision &&
      (!current.plan ||
        current.completed ||
        (current.latest?.kind === "approve" && current.latest.waitForReview))
    );
  if (!current.plan || current.completed) return false;
  if (next.kind === "answer" || next.kind === "stop")
    return current.decision?.id === next.decisionId;
  if (current.decision || next.basis !== current.latest?.id) return false;
  switch (next.kind) {
    case "publish_approve": {
      const thread = current.tasks.find((item) => item.turn.id === next.turnId);
      return (
        !actor &&
        thread?.turn.kind === "report" &&
        thread.task.handoff &&
        !thread.task.handoff.prUrl &&
        thread.task.handoff.head === next.head
      );
    }
    case "task_create":
      return (
        current.queue.length < 200 &&
        next.paths.every((path) => current.plan.paths.includes(path)) &&
        next.dependencies.every((dependency) =>
          current.queue.some((task) => task.id === dependency),
        )
      );
    case "task_accept":
      return current.queue.some(
        (task) =>
          task.id === next.taskId &&
          task.status === "review" &&
          (!task.handoff || Boolean(task.handoff.prUrl)),
      );
    case "task_retry":
      return current.queue.some(
        (task) =>
          task.id === next.taskId &&
          task.status === "blocked" &&
          !current.tasks.some(
            (thread) =>
              thread.task.queuedTaskId === task.id ||
              thread.task.id === task.id,
          ),
      );
    case "assign":
      if (next.queuedTaskId) {
        const queued = current.queue.find(
          (task) => task.id === next.queuedTaskId && task.status === "queued",
        );
        if (
          !queued ||
          queued.dependencies.some(
            (dependency) =>
              !current.queue.some(
                (task) => task.id === dependency && task.status === "complete",
              ),
          ) ||
          next.text !== taskBrief(queued) ||
          JSON.stringify(next.paths) !== JSON.stringify(queued.paths)
        )
          return false;
      }
      if (registry.agents().some((agent) => !agent.revoked)) {
        const target = registry
          .agents()
          .find(
            (agent) =>
              agent.id === next.agentId &&
              !agent.revoked &&
              agent.preset !== "orchestrator",
          );
        if (!target) return false;
        if (current.tasks.some((item) => item.task.agentId === target.id))
          return false;
        const overlaps = (left, right) => {
          const a = left.replaceAll("\\", "/").toLowerCase();
          const b = right.replaceAll("\\", "/").toLowerCase();
          return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        };
        if (
          current.tasks.some((item) => {
            const existing = registry
              .agents()
              .find((agent) => agent.id === item.task.agentId);
            if (target.preset === "reviewer" && existing?.preset === "reviewer")
              return false;
            return next.paths.some((path) =>
              item.task.paths.some((other) => overlaps(path, other)),
            );
          })
        )
          return false;
      } else if (current.task) {
        return false;
      }
      return (
        current.assigned < 20 &&
        next.paths.every((path) => current.plan.paths.includes(path))
      );
    case "reply":
      const thread = current.tasks.find((item) => item.turn.id === next.turnId);
      return (
        thread &&
        thread.replies < 12 &&
        thread.turn.kind === "report" &&
        thread.turn.needsReply
      );
    case "decision":
      return !current.task || current.turn.kind === "report";
    case "complete":
      return (
        !current.task &&
        current.queue.every(
          (task) => task.implicit || task.status === "complete",
        )
      );
    default:
      return false;
  }
}

function record(input, role, actor, human, githubDispatch = false) {
  if (
    actor &&
    registry.agents().find((agent) => agent.id === actor.id)?.revoked
  )
    return false;
  const body = JSON.stringify({
    ...input.action,
    ...(githubDispatch ? { source: "github" } : {}),
    ...(actor ? { actorId: actor.id } : {}),
    ...(human ? { humanId: human.id, humanName: human.name } : {}),
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    const previous = findEvent.get(input.id);
    if (previous) {
      if (
        previous.role !== role ||
        previous.body !== body ||
        previous.project_id !== currentProjectId()
      )
        return false;
    } else {
      if (!allowed(state(), input.action, role, actor, githubDispatch))
        return false;
      insert.run(input.id, role, body, currentProjectId());
      if (input.action.kind === "approve")
        projects.updateScope(input.action.text, input.action.paths);
    }
    database.exec("COMMIT");
    if (!previous) notifySubscribers();
    return true;
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
  }
}

const digest = (value) => createHash("sha256").update(value).digest();
const ownerDigest = digest(`Bearer ${ownerKey}`);
const workerDigest = digest(`Bearer ${workerKey}`);
const subscribers = new Map();
const dashboardPassword = process.env.VIZOR_DASHBOARD_PASSWORD;
const dashboardOrigin = process.env.VIZOR_DASHBOARD_ORIGIN;
if (
  dashboardPassword &&
  (dashboardPassword.length < 24 ||
    !dashboardOrigin ||
    new URL(dashboardOrigin).origin !== dashboardOrigin)
)
  throw Error(
    "Set a dashboard password of at least 24 characters and its exact origin.",
  );
if (
  dashboardPassword &&
  !/^https:\/\//.test(dashboardOrigin) &&
  !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(dashboardOrigin)
)
  throw Error("Use HTTPS for a dashboard shared across machines.");
const dashboardDigest = dashboardPassword
  ? digest(
      "Basic " + Buffer.from("owner:" + dashboardPassword).toString("base64"),
    )
  : null;
const dashboardFiles =
  dashboardDigest &&
  new Map([
    [
      "/",
      [
        "text/html; charset=utf-8",
        readFileSync(new URL("./dashboard/index.html", import.meta.url)),
      ],
    ],
    [
      "/dashboard.css",
      [
        "text/css; charset=utf-8",
        readFileSync(new URL("./dashboard/style.css", import.meta.url)),
      ],
    ],
    [
      "/dashboard.js",
      [
        "text/javascript; charset=utf-8",
        readFileSync(new URL("./dashboard/client.js", import.meta.url)),
      ],
    ],
  ]);
if (dashboardFiles) {
  dashboardFiles.set("/style.css", dashboardFiles.get("/dashboard.css"));
  dashboardFiles.set("/client.js", dashboardFiles.get("/dashboard.js"));
  dashboardFiles.set("/boot.js", [
    "text/javascript; charset=utf-8",
    readFileSync(new URL("./dashboard/boot.js", import.meta.url)),
  ]);
}
const findingRows = z
  .array(
    z.strictObject({
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      number: z.number().int().positive(),
      head: z.string().regex(/^[a-f0-9]{40}$/),
      file: text(500),
      line: z.number().int().positive(),
      title: text(180),
      impact: text(750),
      fix: text(750),
    }),
  )
  .max(30);
const getFindings = () => projects.dashboard("findings");
const saveFindings = (body) => projects.saveDashboard("findings", body);
const repositoryItem = z.strictObject({
  number: z.number().int().positive(),
  title: text(256),
  updatedAt: z.iso.datetime({ offset: true }),
  labels: z.array(text(50)).max(5),
  mergedAt: z.iso.datetime({ offset: true }).nullish(),
});
const repositorySnapshot = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issues: z.array(repositoryItem).max(50).nullable(),
  pulls: z.array(repositoryItem).max(50).nullable(),
  merged: z.array(repositoryItem).max(5).nullable(),
});
const getRepository = () => projects.dashboard("repository");
const saveRepository = (body) => projects.saveDashboard("repository", body);
function notifySubscribers(
  dashboardOnly = false,
  projectId = currentProjectId(),
) {
  for (const [client, subscription] of subscribers) {
    if (projectId && subscription.projectId !== projectId) continue;
    if (dashboardOnly && subscription.identity !== "dashboard") continue;
    if (!client.write("data: change\n\n")) client.destroy();
  }
}
function subscribe(response, role) {
  const subscribedProject = currentProjectId();
  if (subscribers.size >= 128)
    return respond(response, 503, { error: "Too many relay connections." });
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  subscribers.set(response, { identity: role, projectId: currentProjectId() });
  const heartbeat = setInterval(() => {
    if (!response.write(": keep-alive\n\n")) response.destroy();
  }, 15000);
  response.once("close", () => {
    subscribers.delete(response);
    clearInterval(heartbeat);
    if (role !== "dashboard") notifySubscribers(true, subscribedProject);
  });
  // Reconcile saved state on every connection, including after a relay restart.
  response.write("data: change\n\n");
  if (role !== "dashboard") notifySubscribers(true);
}
function respond(response, code, data) {
  response.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function startGitHubWebhook() {
  const port = process.env.VIZOR_GITHUB_WEBHOOK_PORT;
  if (!port) return;
  const secret = z
    .string()
    .min(32)
    .parse(process.env.VIZOR_GITHUB_WEBHOOK_SECRET);
  const projectId = projectIdSchema.parse(process.env.VIZOR_GITHUB_PROJECT_ID);
  const taskId = id.parse(process.env.VIZOR_GITHUB_TASK_ID);
  const agentId = id.parse(process.env.VIZOR_GITHUB_AGENT_ID);
  const label = process.env.VIZOR_GITHUB_DISPATCH_LABEL ?? "vizor:dispatch";
  const hash = createHash("sha256")
    .update(`github-dispatch:${projectId}:${taskId}`)
    .digest("hex");
  const dispatchId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const payload = z.object({
    action: z.literal("labeled"),
    label: z.object({ name: z.literal(label) }),
    repository: z.object({ full_name: z.string() }),
    issue: z.object({ number: z.int().positive(), state: z.literal("open") }),
  });

  createServer({ requestTimeout: 15000 }, async (request, response) => {
    try {
      if (request.url !== "/webhooks/github" || request.method !== "POST")
        return respond(response, 404, { error: "Unknown route." });
      const signature = request.headers["x-hub-signature-256"];
      if (
        typeof signature !== "string" ||
        !/^sha256=[a-f0-9]{64}$/.test(signature)
      )
        return respond(response, 401, { error: "Invalid GitHub signature." });
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 262144)
          return respond(response, 413, {
            error: "Webhook payload is too large.",
          });
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const expected = createHmac("sha256", secret).update(bytes).digest();
      if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex")))
        return respond(response, 401, { error: "Invalid GitHub signature." });
      if (request.headers["x-github-event"] !== "issues")
        return respond(response, 200, { ignored: true });
      let json;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        return respond(response, 400, { error: "Invalid webhook payload." });
      }
      const event = payload.safeParse(json);
      if (!event.success) return respond(response, 200, { ignored: true });

      return projectContext.run(projectId, () => {
        const project = projects.get();
        const repo = event.data.repository.full_name.toLowerCase();
        const issueUrl = `https://github.com/${repo}/issues/${event.data.issue.number}`;
        const current = state();
        const task = current.queue.find((item) => item.id === taskId);
        if (
          project?.repository.toLowerCase() !== repo ||
          !task?.references.some((url) => url.toLowerCase() === issueUrl)
        )
          return respond(response, 200, { ignored: true });
        if (findEvent.get(dispatchId))
          return respond(response, 200, { duplicate: true, dispatchId });
        const saved = record(
          {
            id: dispatchId,
            action: {
              kind: "assign",
              basis: current.latest?.id,
              queuedTaskId: taskId,
              agentId,
              text: taskBrief(task),
              paths: task.paths,
            },
          },
          "owner",
          null,
          undefined,
          true,
        );
        return saved
          ? respond(response, 202, { dispatchId })
          : respond(response, 409, {
              error: "The saved assignment cannot be dispatched.",
            });
      });
    } catch {
      return respond(response, 500, { error: "Webhook processing failed." });
    }
  }).listen(
    z.coerce.number().int().min(0).max(65535).parse(port),
    "127.0.0.1",
    function () {
      console.log(
        `Vizor GitHub webhook is listening on port ${this.address().port}.`,
      );
    },
  );
}
function agentView() {
  return {
    agents: registry.agents().map((agent) => ({
      ...agent,
      online: [...subscribers.values()].some(
        (item) =>
          item.identity === agent.id && item.projectId === currentProjectId(),
      ),
    })),
    managerId: registry.managerId(),
  };
}
function snapshotFor(role, actor) {
  const current = state();
  const thread =
    actor && role === "worker"
      ? current.tasks.find((item) => item.task.agentId === actor.id)
      : null;
  return {
    role,
    ...current,
    ...(actor && role === "worker"
      ? {
          task: null,
          turn: null,
          claim: null,
          runnerId: null,
          replies: 0,
          ...thread,
        }
      : {}),
    ...agentView(),
    project: projects.get(),
    notes: artifactPeople.entries(currentProjectId()),
    agent: actor ?? null,
    managerSelected: actor
      ? registry.managerId() === actor.id
      : !registry.managerId(),
  };
}

const artifactPeople = artifactMembers(database);
const artifactConnector = createArtifactConnector({
  database,
  projects,
  origins: dashboardOrigin ? [dashboardOrigin] : [],
  view: () => ({
    ...snapshotFor("owner", null),
    notes: artifactPeople.entries(currentProjectId()),
  }),
  record,
  notify: () => notifySubscribers(),
  saveDocument(member, input) {
    const current = state();
    if (!current.plan)
      throw Error(
        "Approve project scope on the host before submitting a brief.",
      );
    if (current.decision)
      throw Error(
        "Resolve the pending decision before submitting a revised brief.",
      );
    const body = JSON.stringify({
      kind: "project_document",
      text: "Plan and assign tasks from the approved project document.",
      document: input.document,
      humanId: member.id,
      humanName: member.name,
    });
    const previous = findEvent.get(input.requestId);
    if (previous) {
      if (previous.body !== body || previous.project_id !== currentProjectId())
        throw Error("This request ID already belongs to another document.");
      return { saved: true, duplicate: true };
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      projects.saveDocument(input.document);
      insert.run(input.requestId, "owner", body, currentProjectId());
      database.exec("COMMIT");
    } finally {
      if (database.isTransaction) database.exec("ROLLBACK");
    }
    notifySubscribers();
    return { saved: true };
  },
});

const server = createServer(
  { requestTimeout: 15000, headersTimeout: 10000 },
  async (request, response) => {
    const url = new URL(request.url, "http://relay.local");
    if (url.pathname === "/mcp") {
      try {
        return await artifactConnector(request, response);
      } catch {
        return respond(response, 500, {
          error: "Connector unavailable. Retry shortly.",
        });
      }
    }
    const projectId = projectIdSchema.safeParse(
      request.headers["x-vizor-project"] ??
        url.searchParams.get("project") ??
        "default",
    );
    if (!projectId.success)
      return respond(response, 400, { error: "Invalid project ID." });
    request.url = url.pathname;
    return projectContext.run(projectId.data, async () => {
      try {
        const hash = digest(request.headers.authorization ?? "");
        const actor = registry.authenticate(hash);
        if (!projects.get())
          return respond(response, 404, { error: "Project was not found." });
        if (actor && !registry.canAccess(actor.id, currentProjectId()))
          return respond(response, 403, {
            error: "This agent is not a member of the project.",
          });
        if (
          timingSafeEqual(hash, workerDigest) &&
          currentProjectId() !== "default"
        )
          return respond(response, 403, {
            error: "Use a named agent connection for this project.",
          });
        const dashboardRequest =
          dashboardFiles &&
          (dashboardFiles.has(request.url) ||
            request.url?.startsWith("/dashboard/"));
        const dashboard =
          dashboardRequest && timingSafeEqual(hash, dashboardDigest);
        if (dashboardRequest && !dashboard) {
          response.setHeader(
            "WWW-Authenticate",
            'Basic realm="BlackForge Vizor", charset="UTF-8"',
          );
          return respond(response, 401, {
            error: "Dashboard sign-in required.",
          });
        }
        if (dashboard) {
          const asset = dashboardFiles.get(request.url);
          if (asset && request.method === "GET") {
            response.writeHead(200, {
              "Content-Type": asset[0],
              "Cache-Control": "no-store",
              "Content-Security-Policy":
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            });
            response.end(asset[1]);
            return;
          }
          if (request.url === "/dashboard/events" && request.method === "GET")
            return subscribe(response, "dashboard");
          if (request.url === "/dashboard/project" && request.method === "GET")
            return respond(response, 200, {
              ...state(),
              ...agentView(),
              project: projects.get(),
              projects: projects.list(),
              availableAgents: registry
                .allAgents()
                .filter((agent) => !agent.revoked),
              presets: agentPresets,
              findings: JSON.parse(getFindings() ?? "[]"),
              repository: JSON.parse(getRepository() ?? "null"),
              connectedRoles: [
                ...new Set(
                  [...subscribers.values()]
                    .filter(
                      (item) =>
                        item.identity !== "dashboard" &&
                        item.projectId === currentProjectId(),
                    )
                    .map((item) => item.identity)
                    .map((value) =>
                      registry.agents().find((agent) => agent.id === value)
                        ?.preset === "orchestrator"
                        ? "owner"
                        : registry.agents().some((agent) => agent.id === value)
                          ? "worker"
                          : value,
                    ),
                ),
              ],
            });
          if (
            ![
              "/dashboard/project",
              "/dashboard/agents",
              "/dashboard/manager",
              "/dashboard/revoke-agent",
              "/dashboard/projects",
              "/dashboard/document",
              "/dashboard/members",
              "/dashboard/remove-member",
              "/dashboard/artifact-members",
            ].includes(request.url) ||
            request.method !== "POST"
          )
            return respond(response, 404, {
              error: "Unknown dashboard route.",
            });
          if (
            request.headers.origin !== dashboardOrigin ||
            !request.headers["content-type"]?.startsWith("application/json")
          )
            return respond(response, 403, {
              error: "Dashboard origin rejected.",
            });
        }
        const role = timingSafeEqual(hash, ownerDigest)
          ? "owner"
          : timingSafeEqual(hash, workerDigest)
            ? "worker"
            : actor
              ? actor.preset === "orchestrator"
                ? "owner"
                : "worker"
              : dashboard
                ? "owner"
                : null;
        if (!role)
          return respond(response, 401, { error: "Invalid pairing key." });
        if (request.url === "/v1/events" && request.method === "GET")
          return subscribe(response, actor?.id ?? role);
        const publication =
          role === "owner" &&
          (!actor || registry.managerId() === actor.id) &&
          !dashboard &&
          request.method === "PUT" &&
          (request.url === "/v1/findings" || request.url === "/v1/repository");
        if (!dashboard && !publication && request.url !== "/v1/project")
          return respond(response, 404, { error: "Unknown route." });
        if (request.method === "GET")
          return respond(response, 200, snapshotFor(role, actor));
        if (!publication && request.method !== "POST")
          return respond(response, 405, { error: "Unsupported request." });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (
            size >
            ((publication && request.url === "/v1/repository") ||
            (dashboard &&
              ["/dashboard/projects", "/dashboard/document"].includes(
                request.url,
              ))
              ? 262144
              : 65536)
          )
            return respond(response, 413, { error: "Message is too large." });
          chunks.push(chunk);
        }
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return respond(response, 400, { error: "Invalid message." });
        }
        if (dashboard && request.url !== "/dashboard/project") {
          if (request.url === "/dashboard/artifact-members") {
            const parsed = z
              .strictObject({
                name: text(80),
                role: z.enum(["owner", "editor", "viewer"]),
                projectIds: z.array(projectIdSchema).min(1).max(100),
              })
              .safeParse(json);
            if (
              !parsed.success ||
              parsed.data.projectIds.some((value) => !projects.get(value))
            )
              return respond(response, 400, {
                error: "Choose a person, role and existing projects.",
              });
            return respond(response, 201, artifactPeople.create(parsed.data));
          }
          if (request.url === "/dashboard/document") {
            const parsed = z
              .strictObject({ requestId: id, document: projectDocument })
              .safeParse(json);
            if (!parsed.success)
              return respond(response, 400, {
                error:
                  "Provide a named text document of at most 20,000 characters.",
              });
            const current = state();
            if (!current.plan || current.decision)
              return respond(response, 409, {
                error:
                  "Approve the project scope and resolve its pending decision before planning from a document.",
              });
            const body = JSON.stringify({
              kind: "project_document",
              text: "Plan and assign tasks from the approved project document.",
              document: parsed.data.document,
            });
            const previous = database
              .prepare("SELECT body, project_id FROM event WHERE id = ?")
              .get(parsed.data.requestId);
            if (previous) {
              if (
                previous.body !== body ||
                previous.project_id !== currentProjectId()
              )
                return respond(response, 409, {
                  error:
                    "This request already belongs to a different document.",
                });
              return respond(response, 200, { project: projects.get() });
            }
            database.exec("BEGIN IMMEDIATE");
            try {
              projects.saveDocument(parsed.data.document);
              insert.run(
                parsed.data.requestId,
                "owner",
                body,
                currentProjectId(),
              );
              database.exec("COMMIT");
            } finally {
              if (database.isTransaction) database.exec("ROLLBACK");
            }
            notifySubscribers(true, null);
            return respond(response, 200, { project: projects.get() });
          }
          if (request.url === "/dashboard/projects") {
            const parsed = projectInput.safeParse(json);
            if (
              !parsed.success ||
              !parsed.data.agentIds.includes(parsed.data.managerId) ||
              !registry
                .allAgents()
                .some(
                  (agent) =>
                    agent.id === parsed.data.managerId &&
                    agent.preset === "orchestrator" &&
                    !agent.revoked,
                ) ||
              parsed.data.agentIds.some(
                (id) =>
                  !registry
                    .allAgents()
                    .some((agent) => agent.id === id && !agent.revoked),
              )
            )
              return respond(response, 400, {
                error:
                  "Provide a project name, goal, repository, approved files, members and an Orchestrator.",
              });
            let created;
            const requestId = parsed.data.requestId ?? randomUUID();
            const creationBody = JSON.stringify({
              ...parsed.data,
              agentIds: [...new Set(parsed.data.agentIds)].sort(),
            });
            const previous = projects.creation(requestId);
            if (previous) {
              if (previous.body !== creationBody)
                return respond(response, 409, {
                  error:
                    "This creation request already belongs to a different project.",
                });
              return respond(response, 200, {
                project: projects.get(previous.project_id),
              });
            }
            database.exec("BEGIN IMMEDIATE");
            try {
              created = projects.create(parsed.data);
              registry.include(parsed.data.agentIds, created);
              projectContext.run(created, () => {
                registry.select(parsed.data.managerId, state());
                insert.run(
                  randomUUID(),
                  "owner",
                  JSON.stringify({
                    kind: "approve",
                    text: parsed.data.goal,
                    paths: parsed.data.paths,
                  }),
                  created,
                );
              });
              projects.saveCreation(requestId, created, creationBody);
              database.exec("COMMIT");
            } finally {
              if (database.isTransaction) database.exec("ROLLBACK");
            }
            notifySubscribers(true, null);
            return respond(response, 201, { project: projects.get(created) });
          }
          if (request.url === "/dashboard/members") {
            const parsed = z
              .strictObject({ agentIds: z.array(id).min(1).max(32) })
              .safeParse(json);
            if (!parsed.success || !registry.include(parsed.data.agentIds))
              return respond(response, 400, {
                error: "Choose registered agents to add to this project.",
              });
            notifySubscribers();
            return respond(response, 200, agentView());
          }
          if (request.url === "/dashboard/agents") {
            const parsed = registrationSchema.safeParse(json);
            if (!parsed.success)
              return respond(response, 400, {
                error: "Provide an agent name, participant and role preset.",
              });
            let created;
            try {
              created = registry.create(parsed.data);
            } catch {
              return respond(response, 409, {
                error: "This project already has 32 active agents.",
              });
            }
            notifySubscribers();
            return respond(response, 201, created);
          }
          const parsed = z.strictObject({ agentId: id }).safeParse(json);
          if (!parsed.success)
            return respond(response, 400, {
              error: "Choose a registered agent.",
            });
          const updated =
            request.url === "/dashboard/manager"
              ? registry.select(parsed.data.agentId, state())
              : request.url === "/dashboard/remove-member"
                ? registry.exclude(parsed.data.agentId, state())
                : !projects.list().some((project) =>
                    projectContext.run(project.id, () => {
                      const current = state();
                      return (
                        current.tasks.some(
                          (thread) =>
                            thread.task.agentId === parsed.data.agentId,
                        ) ||
                        (registry.managerId() === parsed.data.agentId &&
                          (current.task || current.decision))
                      );
                    }),
                  ) && registry.revoke(parsed.data.agentId, state());
          if (!updated)
            return respond(response, 409, {
              error:
                "Choose an active Orchestrator profile to manage the project. Finish assigned work before removing an agent, and choose another manager before removing the selected Orchestrator.",
            });
          for (const [client, subscription] of subscribers)
            if (
              subscription.identity === parsed.data.agentId &&
              (request.url === "/dashboard/revoke-agent" ||
                (request.url === "/dashboard/remove-member" &&
                  subscription.projectId === currentProjectId()))
            )
              client.destroy();
          notifySubscribers();
          if (request.url === "/dashboard/revoke-agent")
            notifySubscribers(true, null);
          return respond(response, 200, agentView());
        }
        if (publication) {
          const isRepository = request.url === "/v1/repository";
          const parsed = (
            isRepository ? repositorySnapshot : findingRows
          ).safeParse(json);
          if (
            !parsed.success ||
            (isRepository &&
              parsed.data.repository.toLowerCase() !==
                projects.get().repository.toLowerCase())
          )
            return respond(response, 400, { error: "Invalid dashboard data." });
          const body = JSON.stringify(parsed.data);
          const stored = isRepository ? getRepository : getFindings;
          if (stored() !== body) {
            (isRepository ? saveRepository : saveFindings)(body);
            notifySubscribers(true);
          }
          return respond(response, 200, { ok: true });
        }
        const input = requestSchema.safeParse(json);
        if (!input.success)
          return respond(response, 400, { error: "Invalid message." });
        if (
          dashboard &&
          ![
            "approve",
            "answer",
            "stop",
            "task_create",
            "task_accept",
            "task_retry",
            "publish_approve",
            "project_message",
          ].includes(input.data.action.kind)
        )
          return respond(response, 403, {
            error: "This action belongs to the runner.",
          });
        if (
          dashboard &&
          input.data.action.kind === "approve" &&
          !input.data.action.draftId &&
          !(input.data.action.waitForReview && !state().plan && !state().draft)
        )
          return respond(response, 400, {
            error: "Choose a current project draft.",
          });
        if (!record(input.data, role, actor))
          return respond(response, 409, {
            error:
              "This action does not match the approved project or current task.",
          });
        return respond(response, 200, snapshotFor(role, actor));
      } catch {
        return respond(response, 500, {
          error: "Shared project storage is unavailable.",
        });
      }
    });
  },
);
server.listen(
  Number(process.env.VIZOR_SHARED_PORT ?? 4387),
  process.env.VIZOR_SHARED_BIND ?? "127.0.0.1",
  () => {
    console.log(
      `Vizor shared project relay is listening on port ${server.address().port}.`,
    );
  },
);
startGitHubWebhook();
