import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

export type CommandResult = { code: number; stdout: string };
export type CommandRunner = (
  cwd: string,
  program: "git" | "gh",
  args: string[],
) => Promise<CommandResult>;
function executable(
  program: "git" | "gh",
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const candidates: string[] = [];
  if (
    program === "gh" &&
    env.VIZOR_NATIVE_HOST &&
    isAbsolute(env.VIZOR_NATIVE_HOST)
  )
    candidates.push(join(env.VIZOR_NATIVE_HOST, "github-cli", "gh.exe"));
  if (process.platform === "win32") {
    if (env.ProgramFiles)
      candidates.push(
        join(
          env.ProgramFiles,
          program === "git" ? "Git/cmd/git.exe" : "GitHub CLI/gh.exe",
        ),
      );
    if (env.LOCALAPPDATA)
      candidates.push(
        join(
          env.LOCALAPPDATA,
          program === "git"
            ? "Programs/Git/cmd/git.exe"
            : "Programs/GitHub CLI/gh.exe",
        ),
      );
  }
  for (const entry of String(env.PATH ?? env.Path ?? "").split(delimiter))
    if (isAbsolute(entry))
      candidates.push(
        join(entry, process.platform === "win32" ? `${program}.exe` : program),
      );
  let root = resolve(cwd);
  try {
    root = realpathSync(root);
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const actual = realpathSync(candidate);
      const fromProject = relative(root, actual);
      if (
        fromProject === "" ||
        (!fromProject.startsWith(`..${sep}`) &&
          fromProject !== ".." &&
          !isAbsolute(fromProject))
      )
        continue;
      return actual;
    } catch {}
  }
  return null;
}
export const commandRunner: CommandRunner = (cwd, program, args) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GH_NO_UPDATE_NOTIFIER: "1",
    };
    for (const key of [
      "MASTER_KEY",
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "VIZOR_UPDATE_SIGNING_KEY",
      "VIZOR_TERMINAL_TOKEN",
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
    ])
      delete env[key];
    const binary = executable(program, cwd, env);
    if (!binary) {
      resolve({ code: -1, stdout: "" });
      return;
    }
    execFile(
      /*turbopackIgnore: true*/ binary,
      args,
      {
        cwd,
        env,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout: stdout ?? "",
        }),
    );
  });

type Job = {
  projectId: string;
  folder: string;
  title: string;
  summary: string;
  expectedHead: string | null;
  prNumber: number | null;
  prUrl: string | null;
  checksPassedAt: Date | null;
  checksHash: string | null;
  createdAt: Date;
  reportIds: string[];
  otherReportFiles?: string[];
  writePaths: string[];
};
export type MergeInspection = {
  state: "waiting_checks" | "ready" | "merged" | "blocked" | "waiting_merge";
  reason?: string;
  expectedHead?: string;
  prNumber?: number;
  prUrl?: string;
  checksPassedAt?: Date | null;
  checksHash?: string | null;
  repo?: string;
  strategy?: "--merge" | "--squash" | "--rebase";
};
const blocked = (reason: string): MergeInspection => ({
  state: "blocked",
  reason,
});
const sha = /^[a-f0-9]{40,64}$/i;
function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
function repoName(remote: string) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      remote.trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}
type PullRequest = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  isCrossRepository: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
};
type Check = { name: string; workflow?: string; bucket: string };

export async function inspectGitHubMerge(
  job: Job,
  run: CommandRunner = commandRunner,
  now = new Date(),
): Promise<MergeInspection> {
  const git = (args: string[]) => run(job.folder, "git", args);
  const gh = (args: string[]) => run(job.folder, "gh", args);
  const rootResult = await git(["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0 || !rootResult.stdout.trim())
    return blocked("The selected folder is not inside a Git repository.");
  const root = win32.resolve(rootResult.stdout.trim());
  const relativeFolder = win32.relative(root, win32.resolve(job.folder));
  if (relativeFolder.startsWith("..") || win32.isAbsolute(relativeFolder))
    return blocked("The project folder is outside its Git repository.");
  const status = await git([
    "-c",
    "status.relativePaths=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (status.code !== 0)
    return blocked(
      "Git could not read this project. Install Git and check the project folder.",
    );
  const allowedReports = new Set(
    job.reportIds.map((id) =>
      win32
        .join(relativeFolder, ".vizor", "task-reports", `${id}.json`)
        .replaceAll("\\", "/")
        .toLowerCase(),
    ),
  );
  for (const file of job.otherReportFiles ?? []) {
    const relativeFile = win32.relative(root, win32.resolve(file));
    if (!relativeFile.startsWith("..") && !win32.isAbsolute(relativeFile))
      allowedReports.add(relativeFile.replaceAll("\\", "/").toLowerCase());
  }
  const dirty = status.stdout
    .split("\0")
    .filter(Boolean)
    .some(
      (entry) =>
        entry.slice(0, 3) !== "?? " ||
        !allowedReports.has(entry.slice(3).replaceAll("\\", "/").toLowerCase()),
    );
  if (dirty)
    return blocked(
      "The project has uncommitted changes. Have the coding worker commit only its authorized changes before merging.",
    );
  const branchResult = await git(["branch", "--show-current"]);
  const branch = branchResult.stdout.trim();
  if (branchResult.code !== 0 || branch !== `vizor/${job.projectId}`)
    return blocked(
      "The project must be on its dedicated Vizor feature branch before merging.",
    );
  const headResult = await git(["rev-parse", "--verify", "HEAD"]);
  const head = headResult.stdout.trim();
  if (headResult.code !== 0 || !sha.test(head))
    return blocked("Git could not verify the feature commit.");
  if (job.expectedHead && job.expectedHead !== head)
    return blocked(
      "The feature commit changed while checks were running. Request a new verification.",
    );
  const remoteResult = await git(["remote", "get-url", "origin"]);
  const repo = remoteResult.code === 0 ? repoName(remoteResult.stdout) : null;
  if (!repo)
    return blocked(
      "The origin must be a GitHub repository without credentials in its URL.",
    );
  const remoteHead = await git([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  if (
    remoteHead.code !== 0 ||
    remoteHead.stdout.trim().split(/\s+/)[0] !== head
  )
    return blocked(
      "The feature branch is not pushed at the current commit, or GitHub is unavailable.",
    );
  const authentication = await gh([
    "auth",
    "status",
    "--hostname",
    "github.com",
  ]);
  if (authentication.code !== 0)
    return blocked(
      authentication.code === -1
        ? "Install GitHub CLI and sign in before creating or merging a pull request."
        : "Sign in to GitHub CLI on this PC before creating or merging a pull request.",
    );
  const repoResult = await gh([
    "repo",
    "view",
    repo,
    "--json",
    "defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
  ]);
  const info =
    repoResult.code === 0
      ? parseJson<{
          defaultBranchRef?: { name?: string };
          mergeCommitAllowed?: boolean;
          squashMergeAllowed?: boolean;
          rebaseMergeAllowed?: boolean;
        }>(repoResult.stdout)
      : null;
  const base = info?.defaultBranchRef?.name;
  const strategy: MergeInspection["strategy"] | null = info?.mergeCommitAllowed
    ? "--merge"
    : info?.squashMergeAllowed
      ? "--squash"
      : info?.rebaseMergeAllowed
        ? "--rebase"
        : null;
  if (!base || !strategy || base === branch)
    return blocked(
      "GitHub did not provide a valid base branch and merge method.",
    );
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base) ||
    base.includes("..") ||
    base.includes("//") ||
    base.endsWith(".")
  )
    return blocked("GitHub returned an invalid base branch.");
  const baseRemote = await git([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${base}`,
  ]);
  const baseHead = baseRemote.stdout.trim().split(/\s+/)[0];
  if (baseRemote.code !== 0 || !sha.test(baseHead))
    return blocked("GitHub's base branch could not be verified.");
  const fetched = await git([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "origin",
    `refs/heads/${base}`,
  ]);
  if (fetched.code !== 0)
    return blocked(
      "The GitHub base branch could not be fetched for verification.",
    );
  const changed = await git([
    "diff",
    "--name-only",
    "-z",
    `${baseHead}...${head}`,
    "--",
  ]);
  const files = changed.stdout.split("\0").filter(Boolean);
  if (changed.code !== 0 || !files.length || !job.writePaths.length)
    return blocked(
      "The project has no verifiable scoped changes for this pull request.",
    );
  const allowed = job.writePaths.map((item) =>
    win32.resolve(job.folder, item).toLowerCase(),
  );
  if (
    files.some((file) => {
      const absolute = win32.resolve(root, file).toLowerCase();
      return !allowed.some(
        (scope) => absolute === scope || absolute.startsWith(scope + "\\"),
      );
    })
  )
    return blocked(
      "The feature branch includes changes outside this project's authorized file scopes.",
    );
  let pr: PullRequest | null = null;
  if (job.prNumber) {
    const result = await gh([
      "pr",
      "view",
      String(job.prNumber),
      "--repo",
      repo,
      "--json",
      "number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName",
    ]);
    if (result.code !== 0)
      return blocked("GitHub could not verify the existing pull request.");
    pr = parseJson<PullRequest>(result.stdout);
  } else {
    const result = await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--base",
      base,
      "--state",
      "open",
      "--limit",
      "10",
      "--json",
      "number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName",
    ]);
    const list =
      result.code === 0 ? parseJson<PullRequest[]>(result.stdout) : null;
    if (!Array.isArray(list) || list.length > 1)
      return blocked("GitHub could not uniquely identify the pull request.");
    pr = list[0] ?? null;
    if (!pr) {
      const historyResult = await gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--base",
        base,
        "--state",
        "all",
        "--limit",
        "100",
        "--json",
        "number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName",
      ]);
      const history =
        historyResult.code === 0
          ? parseJson<PullRequest[]>(historyResult.stdout)
          : null;
      if (!Array.isArray(history))
        return blocked(
          "GitHub could not check earlier pull requests. Check GitHub before retrying.",
        );
      const sameCommit = history.filter((item) => item.headRefOid === head);
      if (sameCommit.length > 1)
        return blocked(
          "Multiple pull requests reference this commit. Check GitHub before retrying.",
        );
      if (sameCommit.length === 1) pr = sameCommit[0];
    }
    if (!pr) {
      const created = await gh([
        "pr",
        "create",
        "--repo",
        repo,
        "--base",
        base,
        "--head",
        branch,
        "--title",
        job.title,
        "--body",
        job.summary,
      ]);
      if (created.code !== 0)
        return blocked(
          "GitHub could not confirm pull request creation. Check GitHub before retrying.",
        );
      const listed = await gh([
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--base",
        base,
        "--state",
        "open",
        "--limit",
        "10",
        "--json",
        "number,url,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName",
      ]);
      const matches =
        listed.code === 0 ? parseJson<PullRequest[]>(listed.stdout) : null;
      if (!Array.isArray(matches) || matches.length !== 1)
        return blocked(
          "The new pull request could not be confirmed. Check GitHub before retrying.",
        );
      pr = matches[0];
    }
  }
  if (
    !pr ||
    !Number.isSafeInteger(pr.number) ||
    !pr.url ||
    pr.isDraft !== false ||
    pr.isCrossRepository !== false ||
    pr.headRefName !== branch ||
    pr.baseRefName !== base ||
    pr.headRefOid !== head ||
    !pr.url
      .toLowerCase()
      .startsWith(`https://github.com/${repo}/pull/`.toLowerCase())
  )
    return blocked(
      "The pull request does not match the verified branch, repository, or commit, or it is a draft.",
    );
  const identity = {
    expectedHead: head,
    prNumber: pr.number,
    prUrl: pr.url,
    repo,
    strategy,
  };
  if (pr.state === "MERGED") return { state: "merged", ...identity };
  if (pr.state !== "OPEN") return blocked("The pull request is not open.");
  const args = [
    "pr",
    "checks",
    String(pr.number),
    "--repo",
    repo,
    "--json",
    "name,workflow,bucket",
  ];
  const allResult = await gh(args);
  const requiredResult = await gh([...args, "--required"]);
  const all = parseJson<Check[]>(allResult.stdout);
  const required = parseJson<Check[]>(requiredResult.stdout);
  if (
    !Array.isArray(all) ||
    !Array.isArray(required) ||
    !all.length ||
    !required.length
  ) {
    if (now.getTime() - job.createdAt.getTime() > 300000)
      return blocked(
        "No required GitHub checks were found. Configure required checks before merging.",
      );
    return {
      state: "waiting_checks",
      ...identity,
      checksPassedAt: null,
      checksHash: null,
    };
  }
  if (
    [...all, ...required].some((check) =>
      ["fail", "cancel", "skipping"].includes(check.bucket),
    )
  )
    return blocked(
      "A GitHub check failed or was cancelled. Fix it before merging.",
    );
  if (
    [allResult.code, requiredResult.code].some(
      (code) => code !== 0 && code !== 8,
    )
  )
    return blocked(
      "GitHub could not confirm the checks. Check the pull request before retrying.",
    );
  if ([...all, ...required].some((check) => check.bucket !== "pass"))
    return {
      state: "waiting_checks",
      ...identity,
      checksPassedAt: null,
      checksHash: null,
    };
  const checksHash = createHash("sha256")
    .update(
      JSON.stringify(
        [...all, ...required]
          .map(
            (check) => `${check.workflow ?? ""}:${check.name}:${check.bucket}`,
          )
          .sort(),
      ),
    )
    .digest("hex");
  if (
    !job.checksPassedAt ||
    job.checksHash !== checksHash ||
    now.getTime() - job.checksPassedAt.getTime() < 30000
  )
    return {
      state: "waiting_checks",
      ...identity,
      checksPassedAt:
        job.checksHash === checksHash && job.checksPassedAt
          ? job.checksPassedAt
          : now,
      checksHash,
    };
  return {
    state: "ready",
    ...identity,
    checksPassedAt: job.checksPassedAt,
    checksHash,
  };
}
