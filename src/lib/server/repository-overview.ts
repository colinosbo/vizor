import { z } from "zod";
import { ownedProject } from "./projects";
import { commandRunner, repoName } from "./github-merge-check";

const itemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  updatedAt: z.iso.datetime({ offset: true }),
  labels: z.array(z.object({ name: z.string() })),
  mergedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type RepositoryItem = z.infer<typeof itemSchema>;

export async function projectRepository(userId: string, projectId: string) {
  const { folder } = await ownedProject(userId, projectId);
  const remote = await commandRunner(folder, "git", [
    "remote",
    "get-url",
    "origin",
  ]);
  return {
    folder,
    repository: remote.code === 0 ? repoName(remote.stdout) : null,
  };
}

export async function repositoryIssue(
  userId: string,
  projectId: string,
  number: string,
) {
  const { folder, repository } = await projectRepository(userId, projectId);
  if (!repository || !/^[1-9]\d{0,9}$/.test(number)) return null;
  const [result, timeline] = await Promise.all([
    commandRunner(folder, "gh", [
      "issue",
      "view",
      number,
      "--repo",
      repository,
      "--json",
      "body",
    ]),
    commandRunner(folder, "gh", [
      "api",
      `repos/${repository}/issues/${number}/timeline?per_page=30`,
    ]),
  ]);
  if (result.code !== 0) return null;
  try {
    const issue = z
      .object({ body: z.string() })
      .parse(JSON.parse(result.stdout));
    const timelineSchema = z.array(
      z.object({
        source: z
          .object({ issue: z.object({ html_url: z.string() }).optional() })
          .optional(),
      }),
    );
    let references: string[] = [];
    if (timeline.code === 0) {
      try {
        const items = timelineSchema.parse(JSON.parse(timeline.stdout));
        references = items.flatMap(
          (item) => item.source?.issue?.html_url ?? [],
        );
      } catch {
        // The issue description is still useful when its timeline is unavailable.
      }
    }
    return { body: issue.body.slice(0, 16000), references };
  } catch {
    return null;
  }
}

export async function repositoryOverview(userId: string, projectId: string) {
  const { folder, repository } = await projectRepository(userId, projectId);
  if (!repository)
    return { repository: null, issues: null, pulls: null, merged: null };
  const repo = repository;
  async function list(
    type: "issue" | "pr",
    state: "open" | "merged",
    limit: number,
  ) {
    const fields =
      "number,title,updatedAt,labels" + (state === "merged" ? ",mergedAt" : "");
    try {
      const result = await commandRunner(folder, "gh", [
        type,
        "list",
        "--repo",
        repo,
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        fields,
      ]);
      if (result.code !== 0) return null;
      const parsed = z.array(itemSchema).safeParse(JSON.parse(result.stdout));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  const [issues, pulls, merged] = await Promise.all([
    list("issue", "open", 50),
    list("pr", "open", 50),
    list("pr", "merged", 5),
  ]);
  return { repository, issues, pulls, merged };
}
export type RepositoryOverview = Awaited<ReturnType<typeof repositoryOverview>>;
