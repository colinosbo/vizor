import { expect, it } from "vitest";
import {
  inspectGitHubMerge,
  type CommandRunner,
} from "../src/lib/server/github-merge-check";

const head = "a".repeat(40);
const projectId = "project123";
const pr = {
  number: 7,
  url: "https://github.com/example/repo/pull/7",
  state: "OPEN",
  isDraft: false,
  isCrossRepository: false,
  headRefName: `vizor/${projectId}`,
  headRefOid: head,
  baseRefName: "main",
};
const job = {
  projectId,
  folder: "C:\\work\\repo",
  title: "Implement feature",
  summary: "Feature summary",
  expectedHead: null,
  prNumber: null,
  prUrl: null,
  checksPassedAt: null,
  checksHash: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  reportIds: ["report1"],
  writePaths: ["src"],
};
function fixture(
  options: {
    dirty?: boolean;
    authMissing?: boolean;
    checks?: string;
    required?: boolean;
    draft?: boolean;
    pushed?: string;
    existing?: boolean;
  } = {},
) {
  const calls: { program: string; args: string[] }[] = [];
  let created = false;
  const run: CommandRunner = async (_cwd, program, args) => {
    calls.push({ program, args });
    if (program === "git") {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
        return { code: 0, stdout: "C:\\work\\repo\n" };
      if (args.includes("status"))
        return {
          code: 0,
          stdout: options.dirty
            ? " M private.txt\0"
            : "?? .vizor/task-reports/report1.json\0",
        };
      if (args[0] === "branch")
        return { code: 0, stdout: `vizor/${projectId}\n` };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n` };
      if (args[0] === "remote")
        return { code: 0, stdout: "https://github.com/example/repo.git\n" };
      if (args[0] === "ls-remote")
        return {
          code: 0,
          stdout: `${args.at(-1) === "refs/heads/main" ? "d".repeat(40) : (options.pushed ?? head)}\t${args.at(-1)}\n`,
        };
      if (args[0] === "fetch") return { code: 0, stdout: "" };
      if (args[0] === "diff") return { code: 0, stdout: "src/a.ts\0" };
    }
    if (args[0] === "auth")
      return { code: options.authMissing ? -1 : 0, stdout: "" };
    if (args[0] === "repo")
      return {
        code: 0,
        stdout: JSON.stringify({
          defaultBranchRef: { name: "main" },
          mergeCommitAllowed: true,
        }),
      };
    if (args[0] === "pr" && args[1] === "list")
      return {
        code: 0,
        stdout: JSON.stringify(
          options.existing !== false || created
            ? [{ ...pr, isDraft: !!options.draft }]
            : [],
        ),
      };
    if (args[0] === "pr" && args[1] === "create") {
      created = true;
      return { code: 0, stdout: pr.url };
    }
    if (args[0] === "pr" && args[1] === "view")
      return {
        code: 0,
        stdout: JSON.stringify({ ...pr, isDraft: !!options.draft }),
      };
    if (args[0] === "pr" && args[1] === "checks")
      return {
        code: 0,
        stdout: JSON.stringify(
          args.includes("--required") && options.required === false
            ? []
            : [
                {
                  name: "build",
                  workflow: "CI",
                  bucket: options.checks ?? "pass",
                },
              ],
        ),
      };
    throw Error(`Unexpected fixture command: ${program} ${args.join(" ")}`);
  };
  return { run, calls };
}

it("creates only normal pull requests and requires stable passing required checks", async () => {
  const f = fixture({ existing: false });
  const first = await inspectGitHubMerge(
    job,
    f.run,
    new Date("2026-01-01T00:01:00Z"),
  );
  expect(first.state).toBe("waiting_checks");
  expect(
    f.calls.find((call) => call.args[0] === "pr" && call.args[1] === "create")
      ?.args,
  ).not.toContain("--draft");
  const second = await inspectGitHubMerge(
    {
      ...job,
      expectedHead: first.expectedHead!,
      prNumber: first.prNumber!,
      prUrl: first.prUrl!,
      checksPassedAt: first.checksPassedAt!,
      checksHash: first.checksHash!,
    },
    f.run,
    new Date("2026-01-01T00:01:31Z"),
  );
  expect(second).toMatchObject({
    state: "ready",
    expectedHead: head,
    prNumber: 7,
  });
  expect(
    f.calls.some((call) => call.args[0] === "pr" && call.args[1] === "merge"),
  ).toBe(false);
});
it("never declares a merge ready for unsafe or unverified states", async () => {
  for (const options of [
    { dirty: true },
    { authMissing: true },
    { draft: true },
    { pushed: "b".repeat(40) },
    { checks: "fail" },
    { checks: "skipping" },
  ])
    expect(
      (
        await inspectGitHubMerge(
          job,
          fixture(options).run,
          new Date("2026-01-01T00:01:00Z"),
        )
      ).state,
    ).toBe("blocked");
  expect(
    (
      await inspectGitHubMerge(
        job,
        fixture({ checks: "pending" }).run,
        new Date("2026-01-01T00:01:00Z"),
      )
    ).state,
  ).toBe("waiting_checks");
  expect(
    (
      await inspectGitHubMerge(
        job,
        fixture({ required: false }).run,
        new Date("2026-01-01T00:06:00Z"),
      )
    ).state,
  ).toBe("blocked");
  expect(
    (
      await inspectGitHubMerge(
        { ...job, expectedHead: "c".repeat(40) },
        fixture().run,
        new Date("2026-01-01T00:01:00Z"),
      )
    ).state,
  ).toBe("blocked");
});
