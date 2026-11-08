import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, realpath, writeFile, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { commandRunner, repoName } from "./github-merge-check";
import { handoffSchema, checkNames } from "../../../scripts/worker-handoff.mjs";

export type WorkerHandoff = z.infer<typeof handoffSchema>;
export type CheckName = z.infer<typeof checkNames>;
export async function workerGit(folder: string, args: string[]) {
  const result = await commandRunner(folder, "git", args);
  if (result.code !== 0)
    throw Error(
      `Git operation failed (${args[0]}). Inspect the dedicated checkout.`,
    );
  return result.stdout.trim();
}
export async function cleanWorkerTree(folder: string) {
  return !(await workerGit(folder, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).vizor",
  ]));
}
export async function prepareWorkerBranch(
  folder: string,
  executionId: string,
  repository: string,
) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(executionId))
    throw Error("Invalid worker execution ID.");
  if (!(await cleanWorkerTree(folder)))
    throw Error(
      "The dedicated checkout contains existing changes. Inspect them before starting a PR task.",
    );
  const remote = repoName(
    await workerGit(folder, ["remote", "get-url", "origin"]),
  );
  if (remote?.toLowerCase() !== repository.toLowerCase())
    throw Error("The checkout repository does not match the task project.");
  const symbolic = await commandRunner(folder, "git", [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const base =
    symbolic.code === 0
      ? symbolic.stdout.trim().replace(/^origin\//, "")
      : "main";
  if (
    (await commandRunner(folder, "git", ["check-ref-format", "--branch", base]))
      .code !== 0
  )
    throw Error("Invalid PR base branch.");
  const target = await commandRunner(folder, "git", [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${base}^{commit}`,
  ]);
  const currentBranch = await workerGit(folder, ["branch", "--show-current"]);
  if (target.code !== 0 && currentBranch !== base)
    throw Error(
      "Fetch the repository's base branch before starting this worker.",
    );
  const baseHead =
    target.code === 0
      ? target.stdout.trim()
      : await workerGit(folder, ["rev-parse", "HEAD"]);
  const branch = `codex/vizor-${executionId}`;
  const existing = await commandRunner(folder, "git", [
    "rev-parse",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (existing.code === 0) {
    if (existing.stdout.trim() !== baseHead)
      throw Error(
        "This execution's branch already has a different commit. Inspect it before retrying.",
      );
    if (currentBranch !== branch) await workerGit(folder, ["switch", branch]);
  } else await workerGit(folder, ["switch", "-c", branch, baseHead]);
  return { repository, branch, base, baseHead };
}

async function npmCheck(folder: string, script: string) {
  const cli = process.env.npm_execpath;
  if (!cli || !isAbsolute(cli) || basename(cli) !== "npm-cli.js")
    return {
      code: -1,
      output:
        "Start the runner through npm so approved npm checks are available.",
    };
  const resolved = await realpath(cli);
  const fromProject = relative(await realpath(folder), resolved);
  if (!fromProject.startsWith("..") && !isAbsolute(fromProject))
    return {
      code: -1,
      output: "The npm executable must be outside the project checkout.",
    };
  const helper = join(
    process.env.VIZOR_NATIVE_HOST ?? resolve("desktop/terminal-host"),
    "claude-runtime.cjs",
  );
  const env = createRequire(helper)(helper).subscriptionEnvironment();
  env.CI = "true";
  return new Promise<{ code: number; output: string }>((done) => {
    const child = spawn(process.execPath, [resolved, "run", script], {
      cwd: folder,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid)
        execFile(
          join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32",
            "taskkill.exe",
          ),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 10000 },
          () => child.kill(),
        );
      else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill();
        }
      }
    }, 300000);
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.end();
    child.once("error", () => {
      clearTimeout(timer);
      done({ code: -1, output: "The approved check could not start." });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? -2 : (code ?? -1), output });
    });
  });
}
export async function runWorkerChecks(
  folder: string,
  files: string[],
  names: CheckName[],
) {
  const records: string[] = [];
  let passed = true;
  const remote = await commandRunner(folder, "git", [
    "remote",
    "get-url",
    "origin",
  ]);
  const blackForge =
    remote.code === 0 &&
    repoName(remote.stdout)?.toLowerCase() === "crayosog-star/blackforgemc";
  for (const name of [...new Set<CheckName>(["diff", ...names])]) {
    if (blackForge && name !== "diff") {
      records.push(
        `${name} was not run. BlackForge requires build and test verification in GitHub CI.`,
      );
      passed = false;
      continue;
    }
    const result =
      name === "diff"
        ? await commandRunner(folder, "git", [
            "diff",
            "--check",
            "--",
            ...files,
          ]).then((result) => ({ ...result, output: result.stdout }))
        : await npmCheck(folder, name.slice(4)).catch(() => ({
            code: -1,
            output: "The approved check could not start.",
          }));
    let diagnostic = result.code === 0 ? "" : result.output;
    for (const [key, secret] of Object.entries(process.env))
      if (
        secret &&
        secret.length >= 8 &&
        /key|token|secret|password|auth/i.test(key)
      )
        diagnostic = diagnostic.replaceAll(secret, "[redacted]");
    const errorIndex = diagnostic.search(
      /AssertionError|TypeError|SyntaxError|Error:|error TS\d|\bFAIL\b/i,
    );
    diagnostic =
      errorIndex >= 0
        ? diagnostic.slice(errorIndex, errorIndex + 1400)
        : diagnostic.slice(-1000);
    diagnostic = diagnostic
      .replace(/(?:sk-[\w-]+|Bearer\s+[\w.-]+)/g, "[redacted]")
      .replace(/(?:[A-Z]:[\\/][^\s)]+|\/[^\s)]+\/[\w.-]+)/gi, "[local path]")
      .replace(/\s+/g, " ")
      .slice(0, 350);
    records.push(
      `${name === "diff" ? "git diff --check" : "npm run " + name.slice(4)} exited ${result.code}.${diagnostic ? " " + diagnostic : ""}`,
    );
    if (result.code !== 0) passed = false;
  }
  return { passed, records };
}

export async function prepareWorkerHandoff(
  folder: string,
  branch: Awaited<ReturnType<typeof prepareWorkerBranch>>,
  files: string[],
  title: string,
  checks: string[],
  description = "",
) {
  const changed = (
    await workerGit(folder, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      branch.baseHead,
    ])
  )
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await workerGit(folder, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":(exclude).vizor",
    ])
  )
    .split("\0")
    .filter(Boolean);
  const touched = [...new Set([...changed, ...untracked])];
  if (!touched.length || touched.some((file) => !files.includes(file)))
    throw Error(
      "Checks changed files outside the approved scope, or there is no PR change.",
    );
  for (const file of touched) {
    const path = resolve(folder, file);
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (await realpath(path)) !== path
    )
      throw Error("An approved file became a link or was removed.");
  }
  await workerGit(folder, ["add", "--", ...touched]);
  await workerGit(folder, ["commit", "--only", "-m", title, "--", ...touched]);
  const head = await workerGit(folder, ["rev-parse", "HEAD"]);
  if (
    (await workerGit(folder, ["rev-parse", `${head}^`])) !== branch.baseHead ||
    !(await cleanWorkerTree(folder))
  )
    throw Error("The local commit does not match the prepared task branch.");
  const committed = (
    await workerGit(folder, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      branch.baseHead,
      head,
    ])
  )
    .split("\0")
    .filter(Boolean);
  if (committed.some((file) => !files.includes(file)))
    throw Error("The commit contains changes outside task scope.");
  return handoffSchema.parse({
    ...branch,
    head,
    files: committed,
    title,
    checks,
    description: description.slice(0, 800),
  });
}

export async function publishWorkerPr(folder: string, input: WorkerHandoff) {
  const handoff = handoffSchema.parse(input);
  if (
    repoName(
      await workerGit(folder, ["remote", "get-url", "origin"]),
    )?.toLowerCase() !== handoff.repository.toLowerCase() ||
    (await workerGit(folder, ["rev-parse", "HEAD"])) !== handoff.head ||
    (await workerGit(folder, ["branch", "--show-current"])) !==
      handoff.branch ||
    !(await cleanWorkerTree(folder))
  )
    throw Error(
      "The approved branch or commit changed. Prepare a new handoff before publishing.",
    );
  const committed = (
    await workerGit(folder, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      handoff.baseHead,
      handoff.head,
    ])
  )
    .split("\0")
    .filter(Boolean);
  const base = await commandRunner(folder, "git", [
    "rev-parse",
    `refs/remotes/origin/${handoff.base}`,
  ]);
  const baseHead =
    base.code === 0
      ? base.stdout.trim()
      : await workerGit(folder, ["rev-parse", `refs/heads/${handoff.base}`]);
  if (
    baseHead !== handoff.baseHead ||
    (await workerGit(folder, ["rev-parse", `${handoff.head}^`])) !==
      handoff.baseHead
  )
    throw Error("The approved PR base or commit ancestry changed.");
  if (
    JSON.stringify([...committed].sort()) !==
    JSON.stringify([...handoff.files].sort())
  )
    throw Error("The approved commit's file scope changed.");
  const existing = await commandRunner(folder, "gh", [
    "pr",
    "list",
    "--repo",
    handoff.repository,
    "--head",
    handoff.branch,
    "--base",
    handoff.base,
    "--state",
    "all",
    "--json",
    "url,headRefOid,baseRefName",
  ]);
  if (existing.code !== 0)
    throw Error(
      "Could not check for an existing PR. Sign into GitHub CLI before publishing.",
    );
  const pulls = z
    .array(
      z.object({
        url: z.url(),
        headRefOid: z.string(),
        baseRefName: z.string(),
      }),
    )
    .parse(JSON.parse(existing.stdout));
  const matching = pulls.find(
    (pull) =>
      pull.headRefOid === handoff.head && pull.baseRefName === handoff.base,
  );
  if (matching) return handoffSchema.parse({ ...handoff, prUrl: matching.url });
  if (pulls.length) throw Error("A different PR already uses this branch.");
  const remote = await workerGit(folder, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${handoff.branch}`,
  ]);
  if (remote && remote.split(/\s/)[0] !== handoff.head)
    throw Error("The remote task branch has a different commit.");
  await workerGit(folder, [
    "push",
    "--porcelain",
    "origin",
    `${handoff.head}:refs/heads/${handoff.branch}`,
  ]);
  const gitDir = await workerGit(folder, ["rev-parse", "--absolute-git-dir"]);
  const bodyFile = join(gitDir, `vizor-pr-${handoff.head}-${randomUUID()}.md`);
  const body = `${handoff.description || handoff.title}\n\nChanged files\n${handoff.files.map((file) => "- " + file).join("\n")}\n\nVerification\n${handoff.checks.map((check) => "- " + check).join("\n")}\n\nRevision ${handoff.head}\n\nManager review and any remaining project checks are pending.\n`;
  await writeFile(bodyFile, body, { flag: "wx", mode: 0o600 });
  try {
    const created = await commandRunner(folder, "gh", [
      "pr",
      "create",
      "--repo",
      handoff.repository,
      "--base",
      handoff.base,
      "--head",
      handoff.branch,
      "--title",
      handoff.title,
      "--body-file",
      bodyFile,
    ]);
    if (created.code !== 0)
      throw Error(
        "PR creation could not be confirmed. Retry the saved approval to reconcile the existing branch and PR.",
      );
    const url = created.stdout.trim();
    if (
      !url
        .toLowerCase()
        .startsWith(
          `https://github.com/${handoff.repository}/pull/`.toLowerCase(),
        )
    )
      throw Error("GitHub did not return the expected PR link.");
    const verified = await commandRunner(folder, "gh", [
      "pr",
      "view",
      url,
      "--repo",
      handoff.repository,
      "--json",
      "headRefOid,baseRefName,url",
    ]);
    if (verified.code !== 0)
      throw Error(
        "The created PR could not be confirmed. The saved approval can reconcile it on retry.",
      );
    const pull = z
      .object({ headRefOid: z.string(), baseRefName: z.string(), url: z.url() })
      .parse(JSON.parse(verified.stdout));
    if (pull.headRefOid !== handoff.head || pull.baseRefName !== handoff.base)
      throw Error(
        "The created PR no longer matches the approved head and base.",
      );
    return handoffSchema.parse({ ...handoff, prUrl: pull.url });
  } finally {
    await unlink(bodyFile).catch(() => {});
  }
}
