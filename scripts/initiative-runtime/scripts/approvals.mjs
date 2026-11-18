import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string"
        ? value.replaceAll("\r\n", "\n")
        : canonical(value),
    )
    .digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const id = (v) =>
  typeof v === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(v);
const repo = (v) => typeof v === "string" && /^[\w.-]+\/[\w.-]+$/.test(v);
const text = (v) => typeof v === "string" && v.length > 0 && v.length <= 30000;
export const validPath = (v) =>
  typeof v === "string" &&
  !v.startsWith("/") &&
  !v.includes("\\") &&
  !v.includes(":") &&
  !v.split("/").some((p) => !p || p === "." || p === "..") &&
  !["*", "**"].includes(v) &&
  !v
    .split("/")
    .some(
      (p) =>
        p === ".git" ||
        p === ".vizor" ||
        /^\.env(?:\.(?:local|production|development))?$/.test(p),
    ) &&
  (!v.includes("*") || /^[^*]+\/\*\*$/.test(v));
export const pathAllowed = (path, scopes) =>
  validPath(path) &&
  scopes.some((scope) =>
    scope.endsWith("/**")
      ? path.startsWith(scope.slice(0, -2))
      : path === scope,
  );

export function managerKey(file) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const privateKey = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const key = { id: digest(publicKey).slice(0, 24), publicKey, privateKey };
  writeFileSync(file, JSON.stringify(key), { flag: "wx", mode: 0o600 });
  return key;
}
export function seal(payload, key) {
  return {
    payload,
    keyId: key.id,
    signature: sign(
      null,
      Buffer.from(canonical(payload)),
      createPrivateKey(key.privateKey),
    ).toString("base64"),
  };
}
export function verified(envelope, policy, kind) {
  try {
    const key = policy.keys.find((k) => k.id === envelope.keyId);
    return Boolean(
      key &&
      envelope.payload.repository === policy.repository &&
      envelope.payload.kind === kind &&
      verify(
        null,
        Buffer.from(canonical(envelope.payload)),
        createPublicKey(key.publicKey),
        Buffer.from(envelope.signature, "base64"),
      ),
    );
  } catch {
    return false;
  }
}
export function validatePlan(plan, agents) {
  if (
    plan?.schema !== "vizor.plan/1" ||
    !repo(plan.repository) ||
    !id(plan.id) ||
    !Array.isArray(plan.phases) ||
    !plan.phases.length ||
    plan.phases.length > 32
  )
    throw Error("Invalid approved plan.");
  const keys = new Set();
  const phaseIds = new Set();
  for (const phase of plan.phases) {
    if (
      !id(phase.id) ||
      phaseIds.has(phase.id) ||
      !Array.isArray(phase.tasks) ||
      !phase.tasks.length ||
      phase.tasks.length > 64
    )
      throw Error("Invalid phase.");
    phaseIds.add(phase.id);
    for (const task of phase.tasks) {
      if (
        !id(task.key) ||
        keys.has(task.key) ||
        !id(task.agent) ||
        (agents && !agents[task.agent]) ||
        !text(task.title) ||
        !text(task.body) ||
        !text(task.assignment) ||
        !["review", "merge"].includes(task.gate) ||
        !Array.isArray(task.dependsOn) ||
        !task.dependsOn.every((k) => keys.has(k)) ||
        !Array.isArray(task.checks) ||
        !task.checks.every(text) ||
        (task.gate === "merge" ? !task.checks.length : task.checks.length) ||
        !Array.isArray(task.paths) ||
        !task.paths.every(validPath) ||
        (task.gate === "merge" && !task.paths.length) ||
        !Number.isSafeInteger(task.priority) ||
        task.priority < 0 ||
        task.body.includes("```vizor") ||
        task.assignment.includes("### Task for")
      )
        throw Error("Invalid, out-of-order or cyclic plan task: " + task.key);
      keys.add(task.key);
    }
  }
  return plan;
}
export function planEnvelope(plan, key) {
  validatePlan(plan);
  return seal(
    { kind: "plan", repository: plan.repository, plan, hash: digest(plan) },
    key,
  );
}
export function templateFor(policy, payload) {
  const approved = policy.plans.find(
    (p) => p.payload.hash === payload.planHash && verified(p, policy, "plan"),
  );
  if (!approved || digest(approved.payload.plan) !== payload.planHash)
    return null;
  const phase = approved.payload.plan.phases.find(
    (p) => p.id === payload.phase,
  );
  return phase?.tasks.find((t) => t.key === payload.taskKey) ?? null;
}
export function validRegistration(entry, policy) {
  const p = entry?.payload;
  if (
    !verified(entry, policy, "task") ||
    !positive(p.issue) ||
    !/^[1-9]\d*$/.test(p.assignmentId ?? "") ||
    !/^[a-f0-9]{64}$/.test(p.bodyHash ?? "") ||
    !/^[a-f0-9]{64}$/.test(p.assignmentHash ?? "")
  )
    return false;
  const task = templateFor(policy, p);
  const dependencies = task?.dependsOn.map(
    (key) =>
      policy.tasks.find(
        (e) => e.payload.planHash === p.planHash && e.payload.taskKey === key,
      )?.payload.issue,
  );
  return Boolean(
    task &&
    p.agent === task.agent &&
    p.gate === task.gate &&
    same(p.paths, task.paths) &&
    same(p.checks, task.checks) &&
    Array.isArray(p.dependsOn) &&
    p.dependsOn.every(positive) &&
    same(p.dependsOn, dependencies),
  );
}
export function validatePolicy(policy) {
  if (
    policy?.schema !== "vizor.policy/1" ||
    !repo(policy.repository) ||
    !Array.isArray(policy.keys) ||
    !policy.keys.length ||
    !Array.isArray(policy.plans) ||
    !Array.isArray(policy.tasks)
  )
    throw Error("Invalid versioned policy.");
  if (new Set(policy.keys.map((k) => k.id)).size !== policy.keys.length)
    throw Error("Duplicate approval key.");
  for (const p of policy.plans) {
    if (
      !verified(p, policy, "plan") ||
      digest(p.payload.plan) !== p.payload.hash
    )
      throw Error("Invalid plan signature.");
    validatePlan(p.payload.plan);
  }
  if (
    new Set(policy.tasks.map((t) => t.payload.issue)).size !==
      policy.tasks.length ||
    policy.tasks.some((e) => !validRegistration(e, policy))
  )
    throw Error("Invalid task approval.");
  return policy;
}
export function validatePolicyUpdate(previous, next) {
  validatePolicy(previous);
  validatePolicy(next);
  if (
    previous.repository !== next.repository ||
    !same(previous.keys, next.keys) ||
    previous.plans.some((p) => !next.plans.some((n) => same(p, n))) ||
    previous.tasks.some((t) => !next.tasks.some((n) => same(t, n)))
  )
    throw Error(
      "Policy updates may only append signed approvals; key changes and revocations require owner review.",
    );
  return true;
}
export function signedAssignment(body, payload, key) {
  const envelope = seal(
    { ...payload, kind: "assignment", textHash: digest(body) },
    key,
  );
  return (
    body +
    "\n\n<!-- vizor-manager:" +
    Buffer.from(canonical(envelope)).toString("base64url") +
    " -->"
  );
}
export function assignmentApproved({ policy, issue, task, comment }) {
  if (!policy) return false;
  const registration = policy.tasks.find(
    (e) =>
      e.payload.issue === issue.number &&
      e.payload.assignmentId === String(comment.id),
  );
  if (!registration || !validRegistration(registration, policy)) return false;
  const p = registration.payload;
  if (
    p.agent !== task.agent ||
    p.gate !== task.gate ||
    !same(p.dependsOn, task.dependsOn) ||
    !same(p.checks, task.checks) ||
    digest(issue.body) !== p.bodyHash ||
    digest(comment.body) !== p.assignmentHash
  )
    return false;
  const match = /\n\n<!-- vizor-manager:([A-Za-z0-9_-]+) -->$/.exec(
    comment.body ?? "",
  );
  if (!match) return false;
  try {
    const envelope = JSON.parse(Buffer.from(match[1], "base64url"));
    return (
      verified(envelope, policy, "assignment") &&
      envelope.payload.issue === issue.number &&
      envelope.payload.agent === task.agent &&
      envelope.payload.planHash === p.planHash &&
      envelope.payload.textHash === digest(comment.body.slice(0, match.index))
    );
  } catch {
    return false;
  }
}
export function taskRegistration({ policy, issue, task, comment }) {
  const entry = policy.tasks.find(
    (e) => e.payload.issue === issue.number && validRegistration(e, policy),
  );
  return entry && assignmentApproved({ policy, issue, task, comment })
    ? entry.payload
    : null;
}
