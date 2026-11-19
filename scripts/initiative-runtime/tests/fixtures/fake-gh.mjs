// Synthetic GitHub CLI for isolated tests. Serves fixed data; never contacts GitHub.
// FAKE_GH_STATE points at {"labels": {"<issue>": ["label", ...]}}.
// Odd issues belong to worker "worker" (Synthetic Worker), even to "helper".
import { appendFileSync, readFileSync } from "node:fs";

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
