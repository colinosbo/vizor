// Vizor accepts merged code only when the plan's named checks pass on the
// merged commit, so each check must also run on pushes to the default branch.
// Evidence: a check run with that exact name on the default branch's latest
// commit (queued, running or finished all count; doctor checks presence, not
// the result).

export function inspectCheckWorkflows({ github, repository, checks }) {
  const repo = "repos/" + repository;
  try {
    const branch = github("GET", repo).default_branch;
    const result = github(
      "GET",
      repo +
        "/commits/" +
        encodeURIComponent(branch) +
        "/check-runs?per_page=100",
    );
    const names = new Set((result?.check_runs ?? []).map((run) => run.name));
    const missing = checks.filter((check) => !names.has(check));
    return missing.length
      ? {
          ok: false,
          detail:
            "No run of " +
            missing.join(", ") +
            " on the latest " +
            branch +
            " commit. Add a GitHub Actions job with that exact name that runs on pull_request and on push to " +
            branch +
            " (start from examples/vizor-checks.yml), merge it, then rerun doctor.",
        }
      : {
          ok: true,
          detail:
            "Each named check (" +
            checks.join(", ") +
            ") ran on the latest " +
            branch +
            " commit.",
        };
  } catch (error) {
    return {
      ok: false,
      detail: "Could not read check runs: " + error.message,
    };
  }
}
