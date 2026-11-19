// GitHub-side merge rails for the Standard and braZy autonomy levels: one
// repository ruleset on the default branch that requires the plan's named
// checks and blocks force-pushes and deletion, plus "Allow auto-merge".
// Vizor owns only its own ruleset (by name). It never edits or removes the
// owner's other rulesets or branch protection, and never drops a required
// check someone added to its ruleset by hand.

export const RULESET_NAME = "Vizor merge rails";
const LEVELS = ["standard", "brazy"];

// Every check name the rails must require: the approved plan's task checks
// plus the automatic-repair checks. Sorted and de-duplicated.
export function railChecks({ plan, queue } = {}) {
  const names = new Set(queue?.autoRepair?.checks ?? []);
  for (const phase of plan?.phases ?? [])
    for (const task of phase.tasks ?? [])
      for (const check of task.checks ?? []) names.add(check);
  return [...names].sort();
}

function requiredContexts(ruleset) {
  const rule = ruleset?.rules?.find((r) => r.type === "required_status_checks");
  return (rule?.parameters?.required_status_checks ?? []).map((c) => c.context);
}

function rulesetBody(checks) {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "non_fast_forward" },
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: checks.map((context) => ({ context })),
        },
      },
    ],
  };
}

function findRuleset(github, repo) {
  const list = github("GET", repo + "/rulesets?includes_parents=false") ?? [];
  const summary = list.find((r) => r.name === RULESET_NAME);
  return summary ? github("GET", repo + "/rulesets/" + summary.id) : null;
}

function explain(error, action) {
  const text = String(error?.message ?? error);
  if (/HTTP 403/.test(text))
    return (
      "GitHub refused to " +
      action +
      " (HTTP 403). The signed-in account needs admin rights on the repository, and on GitHub Free rulesets only apply to public repositories (private ones need GitHub Pro, Team or Enterprise)."
    );
  if (/HTTP 404/.test(text))
    return (
      "GitHub could not " +
      action +
      " (HTTP 404). The signed-in account needs admin rights on the repository."
    );
  return "Could not " + action + ": " + text;
}

// Apply the rails for a level. Returns { changes, notes, ok }.
export function applyMergeRails({ github, repository, level, checks }) {
  const repo = "repos/" + repository;
  const changes = [];
  const notes = [];
  if (!LEVELS.includes(level)) {
    notes.push(
      "Supervised: no GitHub settings changed. You merge every PR yourself.",
    );
    return { changes, notes, ok: true };
  }
  try {
    const meta = github("GET", repo);
    if (meta.allow_auto_merge !== true) {
      github("PATCH", repo, { allow_auto_merge: true });
      changes.push("Turned on Allow auto-merge.");
    }
  } catch (error) {
    notes.push(explain(error, "turn on auto-merge"));
    return { changes, notes, ok: false };
  }
  if (!checks.length) {
    notes.push(
      "No named checks yet, so no required checks were set. Run vizor rails again after the plan with its checks is merged.",
    );
    return { changes, notes, ok: true };
  }
  try {
    const existing = findRuleset(github, repo);
    if (!existing) {
      github("POST", repo + "/rulesets", rulesetBody(checks));
      changes.push(
        "Created ruleset '" +
          RULESET_NAME +
          "' on the default branch: requires " +
          checks.join(", ") +
          "; blocks force-push and deletion.",
      );
    } else {
      const current = requiredContexts(existing);
      const merged = [...new Set([...current, ...checks])].sort();
      const missing = merged.filter((c) => !current.includes(c));
      if (missing.length || existing.enforcement !== "active") {
        github("PUT", repo + "/rulesets/" + existing.id, rulesetBody(merged));
        changes.push(
          "Updated ruleset '" +
            RULESET_NAME +
            "': requires " +
            merged.join(", ") +
            ".",
        );
      }
    }
  } catch (error) {
    notes.push(explain(error, "set the required checks"));
    return { changes, notes, ok: false };
  }
  return { changes, notes, ok: true };
}

// Read-only check for doctor. Returns { ok, detail }.
export function inspectMergeRails({ github, repository, level, checks }) {
  if (!LEVELS.includes(level))
    return { ok: true, detail: "Supervised: you merge every PR yourself." };
  const repo = "repos/" + repository;
  try {
    const meta = github("GET", repo);
    if (meta.allow_auto_merge !== true)
      return {
        ok: false,
        detail: "Allow auto-merge is off. Run vizor rails.",
      };
    if (!checks.length)
      return {
        ok: true,
        detail:
          "Auto-merge is on. No named checks yet; run vizor rails after the plan is merged.",
      };
    const ruleset = findRuleset(github, repo);
    const required = requiredContexts(ruleset);
    const missing = checks.filter((c) => !required.includes(c));
    if (!ruleset || ruleset.enforcement !== "active" || missing.length)
      return {
        ok: false,
        detail:
          (!ruleset
            ? "Ruleset '" + RULESET_NAME + "' is missing"
            : ruleset.enforcement !== "active"
              ? "Ruleset '" + RULESET_NAME + "' is not active"
              : "Required checks are missing: " + missing.join(", ")) +
          ". A PR could merge before its checks pass. Run vizor rails.",
      };
    return {
      ok: true,
      detail:
        "Auto-merge is on and the default branch requires " +
        checks.join(", ") +
        ".",
    };
  } catch (error) {
    return { ok: false, detail: explain(error, "read the merge settings") };
  }
}
