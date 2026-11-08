import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runHeadlessWorker } from "../src/lib/server/headless-worker";
import { publishWorkerPr } from "../src/lib/server/worker-delivery";
import { runClaude } from "../src/lib/server/subscription";
import { commandRunner } from "../src/lib/server/github-merge-check";

vi.mock("../src/lib/server/subscription", () => ({ runClaude: vi.fn() }));
vi.mock("../src/lib/server/github-merge-check", async (original) => {
  const module =
    await original<typeof import("../src/lib/server/github-merge-check")>();
  return { ...module, commandRunner: vi.fn(module.commandRunner) };
});
const actual = await vi.importActual<
  typeof import("../src/lib/server/github-merge-check")
>("../src/lib/server/github-merge-check");
function fixture() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "vizor-delivery-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", folder, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Vizor Test");
  git("config", "user.email", "test@vizor.local");
  git("config", "core.autocrlf", "false");
  git(
    "config",
    "core.whitespace",
    "blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol",
  );
  git("remote", "add", "origin", "https://github.com/example/repository.git");
  writeFileSync(join(folder, "a.txt"), "zero\r\n");
  writeFileSync(join(folder, "b.txt"), "zero\n");
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({
      name: "worker-fixture",
      scripts: { test: "node check.cjs" },
    }),
  );
  writeFileSync(
    join(folder, "check.cjs"),
    'const fs=require("node:fs"),assert=require("node:assert/strict"); assert.equal(fs.readFileSync("a.txt","utf8"),"one\\r\\n"); assert.equal(fs.readFileSync("b.txt","utf8"),"one\\n"); assert.equal(fs.readFileSync("new.txt","utf8"),"created\\n");',
  );
  git("add", ".");
  git("commit", "-q", "-m", "Initial fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return { folder, git };
}
function model(
  edits: { file: string; find: string; replace: string }[],
  beforeReply?: () => void,
) {
  vi.mocked(runClaude).mockImplementation(async (args) => {
    if (args[0] === "auth")
      return JSON.stringify({ loggedIn: true, authMethod: "claude.ai" });
    beforeReply?.();
    return JSON.stringify({
      structured_output: {
        outcome: "completed",
        summary: "Updated both defaults and added the supporting file.",
        checks: [],
        artifacts: [],
        questions: [],
        edit: null,
        edits,
      },
    });
  });
}

it("preserves a worker question and applies no edit even if the model claims completion", async () => {
  const { folder, git } = fixture();
  const question = {
    id: "q1",
    question: "What exact value is approved?",
    options: [],
  };
  vi.mocked(runClaude).mockImplementation(async (args) =>
    JSON.stringify(
      args[0] === "auth"
        ? { loggedIn: true, authMethod: "claude.ai" }
        : {
            structured_output: {
              outcome: "completed",
              summary: "I need the approved value.",
              questions: [question],
              checks: [],
              artifacts: [],
              edits: [{ file: "a.txt", find: "zero", replace: "guess" }],
            },
          },
    ),
  );
  vi.mocked(commandRunner).mockImplementation(actual.commandRunner);
  const report = await runHeadlessWorker(
    folder,
    "sonnet",
    "Apply only the approved value.",
    ["a.txt"],
  );
  expect(report).toMatchObject({
    outcome: "blocked",
    questions: [question],
    artifacts: [],
  });
  expect(git("status", "--porcelain")).toBe("");
  expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("zero\r\n");
});

it("edits multiple files, runs a real check, commits only scope and reconciles a lost PR response", async () => {
  const { folder, git } = fixture();
  model([
    { file: "a.txt", find: "zero", replace: "one" },
    { file: "b.txt", find: "zero", replace: "one" },
    { file: "new.txt", find: "", replace: "created\n" },
  ]);
  vi.mocked(commandRunner).mockImplementation(actual.commandRunner);
  const report = await runHeadlessWorker(
    folder,
    "sonnet",
    "Update the production defaults.",
    ["a.txt", "b.txt", "new.txt"],
    { preset: "developer" },
    {
      id: randomUUID(),
      repository: "example/repository",
      title: "Fix production defaults",
      checks: ["diff", "npm:test"],
      preparePr: true,
    },
  );
  expect(report.outcome).toBe("completed");
  expect(report.checks).toContain("npm run test exited 0.");
  expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\r\n");
  expect(report.handoff?.files.sort()).toEqual(["a.txt", "b.txt", "new.txt"]);
  expect(git("status", "--porcelain")).toBe("");
  expect(git("rev-parse", "HEAD")).toBe(report.handoff!.head);
  expect(
    vi
      .mocked(commandRunner)
      .mock.calls.some(
        ([, program, args]) => program === "gh" || args[0] === "push",
      ),
  ).toBe(false);
  let remoteHead = "",
    created = false,
    creations = 0;
  vi.mocked(commandRunner).mockImplementation(async (cwd, program, args) => {
    if (program === "git" && args[0] === "ls-remote")
      return {
        code: 0,
        stdout: remoteHead
          ? `${remoteHead}\trefs/heads/${report.handoff!.branch}\n`
          : "",
      };
    if (program === "git" && args[0] === "push") {
      remoteHead = report.handoff!.head;
      return { code: 0, stdout: "pushed" };
    }
    if (program === "gh" && args[1] === "list")
      return {
        code: 0,
        stdout: JSON.stringify(
          created
            ? [
                {
                  url: "https://github.com/example/repository/pull/42",
                  headRefOid: remoteHead,
                  baseRefName: "main",
                },
              ]
            : [],
        ),
      };
    if (program === "gh" && args[1] === "create") {
      creations++;
      const body = readFileSync(args[args.indexOf("--body-file") + 1], "utf8");
      expect(body).toContain("Updated both defaults");
      expect(body).toContain("npm run test exited 0");
      created = true;
      return { code: -1, stdout: "" };
    }
    return actual.commandRunner(cwd, program, args);
  });
  await expect(publishWorkerPr(folder, report.handoff!)).rejects.toThrow(
    "could not be confirmed",
  );
  const published = await publishWorkerPr(folder, report.handoff!);
  expect(published.prUrl).toBe("https://github.com/example/repository/pull/42");
  expect(creations).toBe(1);
  writeFileSync(join(folder, "a.txt"), "manual change\n");
  await expect(publishWorkerPr(folder, report.handoff!)).rejects.toThrow(
    "changed",
  );
});

it("rejects an invalid second edit before applying the first and preserves external edits", async () => {
  const { folder } = fixture();
  vi.mocked(commandRunner).mockImplementation(actual.commandRunner);
  model([
    { file: "a.txt", find: "zero", replace: "one" },
    { file: "b.txt", find: "missing", replace: "one" },
  ]);
  expect(
    (
      await runHeadlessWorker(folder, "sonnet", "Fix defaults.", [
        "a.txt",
        "b.txt",
      ])
    ).outcome,
  ).toBe("blocked");
  expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("zero\r\n");
  model(
    [
      { file: "a.txt", find: "zero", replace: "one" },
      { file: "b.txt", find: "zero", replace: "one" },
    ],
    () => writeFileSync(join(folder, "b.txt"), "manual edit\n"),
  );
  expect(
    (
      await runHeadlessWorker(folder, "sonnet", "Fix defaults.", [
        "a.txt",
        "b.txt",
      ])
    ).outcome,
  ).toBe("blocked");
  expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("zero\r\n");
  expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("manual edit\n");
});

it("does not prepare a publishable handoff when a requested check fails", async () => {
  const { folder, git } = fixture();
  vi.mocked(commandRunner).mockImplementation(actual.commandRunner);
  model([{ file: "a.txt", find: "zero", replace: "wrong" }]);
  const report = await runHeadlessWorker(
    folder,
    "sonnet",
    "Fix defaults.",
    ["a.txt"],
    { preset: "developer" },
    {
      id: randomUUID(),
      repository: "example/repository",
      title: "Fix defaults",
      checks: ["npm:test"],
      preparePr: true,
    },
  );
  expect(report.outcome).toBe("failed");
  expect(report.handoff).toBeUndefined();
  expect(
    report.checks.some((check) => /npm run test exited [1-9]/.test(check)),
  ).toBe(true);
  const failedBranch = git("branch", "--show-current");
  expect(git("status", "--porcelain")).toBe("");
  expect(git("show", `${failedBranch}:a.txt`)).toBe("wrong");
  model([
    { file: "a.txt", find: "zero", replace: "one" },
    { file: "b.txt", find: "zero", replace: "one" },
    { file: "new.txt", find: "", replace: "created\n" },
  ]);
  const retry = await runHeadlessWorker(
    folder,
    "sonnet",
    "Apply the corrected change across the approved files.",
    ["a.txt", "b.txt", "new.txt"],
    { preset: "developer" },
    {
      id: randomUUID(),
      repository: "example/repository",
      title: "Fix defaults",
      checks: ["npm:test"],
      preparePr: true,
    },
  );
  expect(retry.outcome).toBe("completed");
  expect(retry.handoff).toBeTruthy();
  expect(git("show", `${failedBranch}:a.txt`)).toBe("wrong");
});

it("verifies a newly created PR against the approved head and base", async () => {
  const { folder } = fixture();
  vi.mocked(commandRunner).mockImplementation(actual.commandRunner);
  model([{ file: "a.txt", find: "zero", replace: "one" }]);
  const report = await runHeadlessWorker(
    folder,
    "sonnet",
    "Fix the default.",
    ["a.txt"],
    { preset: "developer" },
    {
      id: randomUUID(),
      repository: "example/repository",
      title: "Fix default",
      checks: ["diff"],
      preparePr: true,
    },
  );
  vi.mocked(commandRunner).mockImplementation(async (cwd, program, args) => {
    if (program === "git" && args[0] === "ls-remote")
      return { code: 0, stdout: "" };
    if (program === "git" && args[0] === "push") {
      expect(args[3]).toBe(
        `${report.handoff!.head}:refs/heads/${report.handoff!.branch}`,
      );
      return { code: 0, stdout: "pushed" };
    }
    if (program === "gh" && args[1] === "list")
      return { code: 0, stdout: "[]" };
    if (program === "gh" && args[1] === "create")
      return {
        code: 0,
        stdout: "https://github.com/example/repository/pull/43\n",
      };
    if (program === "gh" && args[1] === "view")
      return {
        code: 0,
        stdout: JSON.stringify({
          url: "https://github.com/example/repository/pull/43",
          headRefOid: report.handoff!.head,
          baseRefName: "main",
        }),
      };
    return actual.commandRunner(cwd, program, args);
  });
  expect((await publishWorkerPr(folder, report.handoff!)).prUrl).toContain(
    "/pull/43",
  );
});
