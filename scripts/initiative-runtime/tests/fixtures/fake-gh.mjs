// Synthetic GitHub CLI for isolated tests. Serves fixed data; never contacts GitHub.
// FAKE_GH_STATE points at {"labels": {"<issue>": ["label", ...]}}.
// Odd issues belong to worker "worker" (Synthetic Worker), even to "helper".
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("gh version 0.0.0-synthetic");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  console.log("synthetic-token");
  process.exit(0);
}
if (args[0] !== "api") process.exit(1);
const method = args[args.indexOf("-X") + 1];
const path = args[4];
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const repo = "repos/synthetic-owner/synthetic-repo";
const owner = (n) => (n % 2 ? "worker" : "helper");
const display = (n) => (n % 2 ? "Synthetic Worker" : "Synthetic Helper");
let body = {};
const save = () =>
  writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state));
const respond = (status, value) => {
  process.stdout.write(
    "HTTP/2.0 " +
      status +
      "\r\ncontent-type: application/json\r\n\r\n" +
      JSON.stringify(value),
  );
  process.exit(status >= 400 ? 1 : 0);
};
// Merge rails: auto-merge flag, rulesets and the approved plan file.
if (path === repo && method === "PATCH") {
  state.allowAutoMerge = JSON.parse(readFileSync(0, "utf8")).allow_auto_merge;
  save();
  respond(200, { allow_auto_merge: state.allowAutoMerge });
}
if (path.startsWith(repo + "/contents/"))
  state.plan
    ? respond(200, {
        encoding: "base64",
        sha: "synthetic",
        content: Buffer.from(JSON.stringify(state.plan)).toString("base64"),
      })
    : respond(404, { message: "Not Found" });
if (path.startsWith(repo + "/rulesets")) {
  if (state.rulesetStatus) respond(state.rulesetStatus, { message: "No" });
  state.rulesets ??= [];
  const id = Number(path.match(/rulesets\/(\d+)/)?.[1]);
  if (method === "GET" && !id)
    respond(
      200,
      state.rulesets.map(({ id, name }) => ({ id, name })),
    );
  if (method === "GET")
    respond(
      200,
      state.rulesets.find((r) => r.id === id),
    );
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (method === "POST")
    state.rulesets.push({ ...input, id: state.rulesets.length + 1 });
  if (method === "PUT")
    state.rulesets = state.rulesets.map((r) =>
      r.id === id ? { ...input, id } : r,
    );
  save();
  respond(200, {});
}
const label = /\/labels\/([^/]+)$/.exec(path);
if (
  method === "GET" &&
  label &&
  (state.missingLabels ?? []).includes(decodeURIComponent(label[1]))
) {
  process.stdout.write(
    'HTTP/2.0 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"Not Found"}',
  );
  process.exit(1);
}
if (method === "POST" && path.endsWith("/labels") && process.env.FAKE_GH_LOG)
  appendFileSync(process.env.FAKE_GH_LOG, readFileSync(0, "utf8") + "\n");
if (method === "GET") {
  if (path === "user") body = { login: "synthetic-lead" };
  else if (path === repo)
    body = {
      full_name: "synthetic-owner/synthetic-repo",
      default_branch: "main",
      allow_auto_merge: state.allowAutoMerge ?? false,
    };
  else if (/\/labels\//.test(path))
    body = { name: decodeURIComponent(path.split("/").at(-1)) };
  else if (/\/issues\/\d+\/comments/.test(path)) {
    const n = Number(path.match(/issues\/(\d+)/)[1]);
    body = [
      {
        id: n * 100,
        user: { login: "synthetic-lead" },
        body: "### Task for " + display(n) + "\nSynthetic task only.",
      },
    ];
  } else if (/\/issues\/\d+$/.test(path)) {
    const n = Number(path.match(/issues\/(\d+)$/)[1]);
    body = {
      number: n,
      state: "open",
      labels: (state.labels[n] ?? [owner(n)]).map((name) => ({ name })),
      body:
        "```vizor\n" +
        JSON.stringify({
          agent: owner(n),
          dependsOn: [],
          gate: "review",
          checks: [],
          priority: n,
        }) +
        "\n```",
    };
  }
}
process.stdout.write(
  "HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n" +
    JSON.stringify(body),
);
