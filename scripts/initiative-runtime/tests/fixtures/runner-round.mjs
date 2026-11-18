// One runner start against a project, using a given installed runtime:
//   node runner-round.mjs <runtime dir> <project dir> <ok|lost-response|hold>
// GitHub is fake-gh.mjs; the provider is a stub that appends each fire to FIRE_LOG.
// "hold" keeps the scheduler running (holding the queue lease) until killed.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const [runtime, project, mode] = process.argv.slice(2);
const load = (file) =>
  import(pathToFileURL(join(runtime, "scripts", file)).href);
process.chdir(project);
// Record the installed runtime as this process's executable, like the CLI does.
process.argv[1] = join(runtime, "scripts", "vizor.mjs");
const { createDispatcher, openDispatchStore } = await load("relay.mjs");
const { openSchedulerStore, runScheduler } = await load("scheduler.mjs");
const { createGitHubClient } = await load("github-client.mjs");
const config = JSON.parse(readFileSync("vizor.config.json", "utf8"));
const credentials = JSON.parse(readFileSync(".vizor/secrets.json", "utf8"));
const key = createHash("sha256")
  .update(config.repository.toLowerCase())
  .digest("hex");
const db = openDispatchStore(new DatabaseSync(".vizor/" + key + ".db"));
openSchedulerStore(db);
const fakeGh = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));
const client = createGitHubClient({
  scope: "synthetic",
  execute: (_exe, args, options) =>
    spawnSync(process.execPath, [fakeGh, ...args], options),
});
const github = (...a) => client(...a);
github.budget = () => client.budget();
const fire = async (_url, options) => {
  appendFileSync(
    process.env.FIRE_LOG,
    JSON.stringify({ pid: process.pid, text: JSON.parse(options.body).text }) +
      "\n",
  );
  if (mode === "lost-response")
    throw Object.assign(Error("timeout"), { name: "TimeoutError" });
  return Response.json({
    claude_code_session_id: "session_synthetic" + process.pid,
  });
};
const dispatcher = createDispatcher({
  config,
  credentials,
  database: db,
  fire,
});
try {
  await runScheduler({
    db,
    config,
    file: ".vizor/queue.json",
    once: mode !== "hold",
    github,
    reachable: () => true,
    dispatch: (issue) => dispatcher(issue, randomUUID()),
    log: () => {},
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 3;
} finally {
  db.close();
  client.close();
}
