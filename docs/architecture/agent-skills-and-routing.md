# Agent Skills and model routing

Date: 2026-10-30
Status: Proposed technical design; companion to [Vizor intelligent orchestration](intelligent-orchestration.md).

## The central interaction

A skill changes the information available to a model and the procedure it should follow. It does not change the model's underlying capabilities. Good procedural coverage can reduce ambiguity and search; a precise verifier can detect mistakes. Together, these can make a cheaper model appropriate for a bounded task. Conversely, a skill can reveal that a task requires architecture-level judgment and should start on high tier.

Routing therefore has two passes:

```text
task evidence -> provisional classification -> retrieve skill metadata
-> inspect selected skill contracts -> recompute requirements
-> select eligible model/effort/context -> compile prompt -> count/quote
-> validate actual request -> propose/execute under policy -> verify
-> repair or escalate using preserved evidence
```

Freeze the decision before inference. If loading a reference reveals a new hard requirement, invalidate the preview and recompute before the next call. Permit at most two compile/re-route passes in one admission cycle; if the context still does not fit, split the node or return an explicit blocked condition. Avoid an unbounded skill/model/context selection loop.

## Portable packages and Vizor extensions

The portable core is a directory containing `SKILL.md`, with YAML frontmatter (`name`, `description`) and Markdown instructions, plus optional `scripts/`, `references/`, and `assets/`. The standard supports string-valued `metadata`; `allowed-tools` is experimental. Model tiers, effort policies, DAG dependencies, and task verification are **Vizor extensions**, not standard fields. See the [Agent Skills specification](https://agentskills.io/specification).

Use standard string metadata to point to an optional typed sidecar:

```text
minecraft-fabric-mixin-debug/
  SKILL.md
  vizor.skill.json
  references/
    descriptor-triage.md
  scripts/
    extract-mixin-diagnostics.mjs
  assets/
    handoff-template.json
```

```yaml
---
name: minecraft-fabric-mixin-debug
description: Diagnose Fabric Mixin application failures using exact mappings and target descriptors.
metadata:
  version: "1.0.0"
  vizor-profile: "vizor.skill.json"
---
Confirm Minecraft, loader, mappings, Java and Mixin versions from project evidence.
Extract the first failing target, injection point and descriptor before editing.
Read references/descriptor-triage.md when target resolution is uncertain.
Propose the smallest repair; preserve public behavior and record assumptions.
Run the registered Gradle and disposable-launch checks for the changed revision.
Return artifact references, check evidence and remaining uncertainty.
```

Example sidecar, interpreted only after schema validation:

```json
{
  "$schema": "https://vizor.invalid/schemas/skill-profile-v1.json",
  "schemaVersion": 1,
  "routing": {
    "preferredTier": "high",
    "minimumTier": "medium",
    "preferredEffort": "high",
    "downgradePolicy": "evaluated-only"
  },
  "compatibility": {
    "domains": ["minecraft"],
    "loaders": ["fabric"],
    "requiredFacts": [
      "minecraftVersion",
      "mappings",
      "javaVersion",
      "mixinVersion"
    ]
  },
  "context": { "maxInstructionTokens": 2500, "maxReferenceTokens": 3000 },
  "execution": {
    "requiredCapabilities": ["workspace.read", "workspace.patch", "gradle.run"],
    "writeScopes": ["src/**"],
    "verificationProfileIds": ["gradle-build", "disposable-client-launch"]
  },
  "composition": {
    "requires": [],
    "conflictsWith": [],
    "provides": ["mixin-diagnosis", "verified-mixin-patch"]
  }
}
```

The `.invalid` schema URL is an illustrative identifier, not a published schema or network fetch. Ship and resolve schemas locally by version. Check IDs and capabilities resolve against host-owned registries; packages cannot embed arbitrary executable commands in these fields. Resource limits apply in bytes as well as tokens. A trusted script still runs only through an authorized executor.

Distinguish **package suggestions** from **effective host constraints**. A package can request a preferred/minimum tier, but the host decides which fields are advisory or enforceable after validating its provenance and project binding. A package cannot grant tool permission, override user instructions, increase a spending cap, or certify itself as reliable. Unknown/unbound packages are discoverable reference material until their policy is established.

## Registry, discovery, and version locks

Use explicit roots: bundled read-only packages, user-approved local library roots, and project-bound roots. Scan only configured roots. Do not recursively index an entire user directory. Support debounced filesystem changes and explicit refresh; invalidate affected index entries without changing running tasks.

```ts
interface SkillDescriptor {
  id: string; // Namespaced package identity, not just display name.
  name: string;
  description: string;
  declaredVersion?: string;
  packageDigest: string; // Hash of a sorted file/path/content manifest.
  profileDigest?: string;
  source: "bundled" | "user" | "project" | "registry";
  trust: "unreviewed" | "bound" | "verified-source";
  compatibility: Record<string, string[]>;
  instructionRef: string;
  instructionTokensEstimate: number;
  resourceManifestRef: string;
}

interface SkillActivation {
  taskId: string;
  skillId: string;
  packageDigest: string;
  profileDigest?: string;
  activatedReason: string;
  loadedResources: { relativePath: string; digest: string; tokens: number }[];
}
```

Names alone are ambiguous. A repository package with the same name as a bundled package must not silently shadow it. Use namespaced IDs, explicit project bindings and visible conflicts. Validate YAML using a safe parser with document/alias/size limits, required standard fields, frontmatter boundaries, and a strict sidecar schema. Canonicalize paths and resolve symlinks/junctions before checking containment; reject traversal, device paths, escapes, excessive files, and oversized binary resources. Hashing can inspect bytes for integrity without injecting those bytes into model context.

Lock each task to the full package digest and effective profile digest. Store a copy or content-addressed snapshot so changing the original directory cannot change an approved attempt. Semver communicates compatibility; the digest establishes exact content. Update locks only through a task revision. A critical revocation can block future attempts pending review; it must not silently substitute new instructions.

Start with SQLite metadata plus lexical/FTS search. Filter by domain, loader, tool availability, version facts and project binding before ranking descriptions/tags. Rank exact explicit skill requests first, then compatible task matches, then evidence-backed relevance; return candidate explanations. Treat missing version facts as unknown, not a match.

Add embeddings only after measuring retrieval misses in a large heterogeneous library. Cache embeddings by description/package digest, isolate owners/projects, and record embedding spend. An embedding match is a retrieval signal, not an instruction to activate or an authority signal.

For a future marketplace, require manifest/schema versions, provenance, licenses, digest pinning, dependency locks, revocation metadata and explicit update previews. Signatures establish origin/integrity, not script safety or quality. Never execute package lifecycle hooks during discovery, never auto-install a suggested skill, and retain local portable `SKILL.md` support without requiring a marketplace account.

## Progressive loading with a real catalog budget

The standard's integration guidance separates catalog metadata, activated instructions, and resources loaded as needed. It estimates roughly 50–100 tokens per catalog entry and recommends keeping instructions below 5,000 tokens. Those are guidance, not guaranteed tokenizer counts. See [Integrating Agent Skills](https://agentskills.io/integrate-skills).

Vizor should apply progressive disclosure at two boundaries:

| Stage                   | Host loads/indexes                                     | Model receives                                           |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Discovery/session start | Lightweight metadata for the entire configured library | Full metadata catalog only if it fits the catalog budget |
| Large library retrieval | Filter/rank all metadata locally                       | A bounded candidate catalog plus a metadata search tool  |
| Activation              | Pinned `SKILL.md` body and validated sidecar           | Selected instructions and relevant execution constraints |
| Resource request        | One pinned path/range or tool result                   | Only the requested excerpt/result, with provenance       |
| Task completion         | Outcome and artifact references                        | Compact verified result contract for downstream tasks    |

For example, 200 entries at 75 tokens already consume 15,000 input tokens. A 2,000-token catalog cap is a proposed initial default, not a requirement to load every entry into every agent. Preserve full discoverability through `skills.search`. Do not spend the catalog budget on scripts, references, or long routing profiles.

Proposed read-only skill tools:

```ts
skills.search({ query, projectId, domain, limit: 8 });
skills.activate({ taskId, skillId, packageDigest });
skills.readResource({
  taskId,
  skillId,
  packageDigest,
  path,
  startLine,
  maxLines,
});
```

The server enforces budget limits, ownership, activation, containment, and lock validity regardless of the model arguments. Do not expose arbitrary filesystem reads as a skill resource endpoint. If a resource is required for correctness but cannot fit, replan; do not label an incomplete activation successful.

## Model profiles and provider translation

Treat low/medium/high as capability classes, not permanent mappings to marketing names. Maintain a versioned host catalog, intersected with account model discovery and project/user provider restrictions:

```ts
interface ModelProfile {
  provider: string;
  modelId: string;
  tier: "low" | "medium" | "high";
  capabilities: {
    nativeTools: boolean;
    structuredOutput: boolean;
    contextWindow: number;
    maxOutputTokens: number;
    effortValues: string[];
    thinkingModes: string[];
    temperatureAllowed: boolean;
    opaqueContinuation: boolean;
  };
  effortMap: Partial<Record<"low" | "medium" | "high" | "xhigh", string>>;
  pricingProfileId: string;
  documentationCheckedAt: string;
  adapterVersion: string;
}
```

Model-list endpoints establish availability, not complete capabilities or supported parameters. Unknown models must not be guessed from a name regex. Require a reviewed profile before automatic routing; keep explicit manual selection behavior separately defined. If a high-quality route is unavailable or unpriced for protected spending, report the constraint instead of selecting a weaker model silently.

The internal effort enum expresses intent. The adapter applies a documented mapping only for the selected model:

```ts
// OpenAI Responses API: only for a model profile that supports the value.
{ model: modelId, reasoning: { effort: effectiveEffort }, max_output_tokens: cap }

// Anthropic Messages API: only for a model profile that supports the value.
{ model: modelId, output_config: { effort: effectiveEffort }, max_tokens: cap }
```

Effort values and any required thinking configuration differ by model; these fragments are not complete requests. A missing effort mapping must produce another eligible candidate or a visible `provider-default` route where policy allows it. Never silently map `xhigh` to a value with an assumed equivalent meaning. A required elevated-effort route cannot be satisfied by an unspecified default. Output allowance, temperature compatibility, and timeout must also be validated. See [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) and [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort).

Cache-preserving effort changes also need a capability flag: supported OpenAI models can append a `configuration_update` item instead of changing request-level effort. Other models/providers may require a different mechanism or a fresh request prefix. Gate this optimization by an exact adapter/profile contract; the effective effort recorded for an attempt must reflect the latest applicable setting. See [OpenAI cache-preserving effort changes](https://developers.openai.com/api/docs/guides/prompt-caching).

Extend the existing `SendInput` with structured prompt segments, effective reasoning configuration, cache hints, and continuation items. Keep `maxTokens` backward compatible while clarifying provider completion/reasoning accounting. The existing message shape cannot represent all provider continuation blocks. Preserve opaque reasoning/function-call continuity for the same supported provider/model family, without showing private reasoning to users; serialize compatible items back as required by that provider. For a cross-provider handoff, use an evidence packet rather than incompatible internal blocks. OpenAI documents preserving reasoning items around tool calls in its [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

## Routing policy: hard gates before cost

Initial task routes:

| Task                                                          | Starting route                                            | Conditions                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Known JSON/resource template                                  | Deterministic generator, otherwise low/low                | Exact schema/version facts and checks; no unresolved semantic decisions                               |
| Commit message/formatting                                     | Low/low                                                   | Supplied bounded diff/content; no policy or architecture decisions                                    |
| Ordinary classes, listeners, single-file logic                | Medium/medium                                             | Compatible project/toolchain; concrete acceptance checks                                              |
| Multi-file architecture, difficult Mixin/NMS/packet diagnosis | High/high                                                 | Coupling or uncertainty warrants it; high/xhigh only for a supported profile and sufficient allowance |
| Ambiguous or unclassified non-trivial work                    | Medium/medium intake/planning                             | Resolve missing facts before implementation                                                           |
| Production server changes                                     | Route based on complexity plus explicit operations policy | Model strength never supplies operational authorization                                               |

Compute the floor from the task's intrinsic reasoning needs, verified skill constraints, composition requirements, impact, ambiguity, and failure history. Do not let a boilerplate skill reduce a hard networking/security requirement. A skill preference is a ranking hint; an effective minimum is a constraint. A user model ceiling below the required floor produces a conflict, not an automatic override.

Allow at most a one-tier downgrade from medium to low when **all** of these are true:

- Task is narrow, low impact and low ambiguity; relevant environment facts match.
- A bound skill covers the complete task and its reference/contract needs fit the context budget.
- Strong automated checks exercise semantics required by acceptance criteria, not just syntax.
- Host-owned held-out outcomes qualify the exact skill digest, task cohort, model and effort.
- No existing failure/escalation floor applies, and user/project policy permits the route.

Do not downgrade high-complexity nodes directly because a skill exists. Decompose them into simpler nodes first. Successful cheap recipe generation says nothing about cheap Mixin diagnosis. Compilation alone cannot qualify a skill for behavioral game logic.

```ts
function chooseRoute(task, skills, evidence, policy, catalog) {
  const requirements = deriveRequirements(task, skills, evidence, policy);
  const candidates = catalog
    .filter((m) => availableToOwner(m, policy))
    .filter((m) => supportsRequiredToolsAndFormats(m, requirements))
    .filter((m) => meetsTierAndEffortFloor(m, requirements))
    .filter((m) => permittedProviderAndDataHandling(m, policy))
    .filter((m) => hasUsablePriceWhenRequired(m, policy))
    .flatMap((m) => eligibleEffortAndContextProfiles(m, requirements));

  const feasible = candidates.filter((c) =>
    mandatoryContextCanFit(c, requirements),
  );
  if (!feasible.length) return blockedWithExcludedCandidateReasons();
  return rankByExpectedVerifiedCost(feasible, evidence, policy)[0];
}
```

Then compile the exact request, validate context/output fit, count input tokens and obtain the real quote. Re-admit against current policy, task revision and budget immediately before sending. If the quote fails, try another eligible candidate without lowering quality floors; do not dispatch from an expired preview.

### Evidence-backed cost objective

```text
expected verified cost(route)
  = current inference + expected tool/verification cost
  + P(failure | skill, task cohort, model, effort, environment)
    * expected bounded repair/escalation/integration cost
```

Use the entire finite attempt policy when enough data exists; this expression is a first approximation. Include cache warm-up and cross-provider context transfer. Where local tools have no direct price, track duration/resource cost separately. Apply quality eligibility before ranking cost, then use latency and cache affinity as tie-breakers. Cache affinity must never defeat a capability requirement.

Initialize from balanced/medium with no inferred cheap-model success. Qualify a downgrade using a frozen held-out set with a predeclared success target and confidence bound. For illustration, a 0.95 lower bound on success is much stricter than 19 successes out of 20; roughly 100 flawless independent representative outcomes yield a two-sided 95% Wilson lower bound near 0.963. This illustrates uncertainty, not a universal sample threshold. Correlated fixtures are not independent evidence; require representative semantic cases and manual review where automation cannot establish quality.

Store host-owned outcomes, including failures, exclusions and user interventions. Partition by skill digest, environment/version cohort, task class, model/effort and verifier quality. Do not copy a package's claimed success rate into router evidence. Reset or discount evidence when the skill, check suite, environment, or model revision changes. Exploration belongs in capped evaluations, not a random cheap-model experiment on an important live task.

## Skill composition and task DAGs

Separate skill composition from task scheduling. One task may activate compatible procedures; a workflow has nodes whose artifact dependencies determine scheduling. Do not turn every reference into a sub-agent or every skill into a task.

Resolve `requires` as pinned package dependencies, bounded in number/depth and checked for cycles. Combine effective minimum tiers/efforts and required capabilities conservatively. Sum instruction/resource allowances; subtract duplicate references by digest. Resolve declared conflicts before execution. If procedures or write ownership conflict, split tasks or report an unresolved conflict rather than concatenate contradictory instructions.

For `mixin-debug + gradle-triage`, Mixin diagnosis keeps its reasoning floor while log extraction can run deterministically. For `resource-boilerplate + mod-architecture-review`, split generation and architecture review into different nodes so every generated JSON file does not pay for flagship context.

Task output contracts should include:

```ts
interface TaskResult {
  taskId: string;
  attemptId: string;
  baseCommit?: string;
  producedRevision: string;
  artifacts: { id: string; digest: string; kind: string }[];
  summary: string;
  decisions: { text: string; evidenceRefs: string[] }[];
  verificationIds: string[];
  unresolved: string[];
}
```

Downstream nodes consume result contracts and required artifacts, not transcripts. A dependency is satisfied only when its relevant checks pass and the referenced revision is available. Any upstream contract change invalidates affected downstream assumptions and approvals.

## Two-failure escalation, precisely defined

Count failures by task lineage and acceptance-check group, across agent/model changes. An attempt is one implementation/repair cycle followed by its required checks. Two failing tests within the same cycle count as one failed cycle. Re-running the same unchanged check does not increment the streak. Deduplicate with attempt/check/artifact/environment keys.

1. Record a failed required check against the produced artifact and environment. Retain a compact diagnostic packet and full local evidence reference.
2. Determine whether it is an implementation failure, environment blocker, provider failure, or authorization issue. Ambiguous evidence is `inconclusive`, not success.
3. After the first implementation failure, permit one repair at the same tier within remaining policy limits. Increase context only when the diagnostics justify it; do not dump the raw log.
4. After the second consecutive failed implementation cycle, set the effective floor to high and request elevated supported effort. Preserve the same task ID and increment the attempt. Emit one escalation event with both evidence IDs.
5. Under current manual execution, create an escalation proposal. Under a future explicit bounded policy, admit and execute automatically only if all authorization, capability and cost conditions remain satisfied.
6. If already high, use a supported higher effort only if policy permits; otherwise stop and produce a diagnostic handoff. Never loop indefinitely.

Reset the streak only after **all required checks for the relevant task revision pass**. Passing an unrelated check, changing the worker, or editing the prompt does not reset it. A material task rewrite creates a linked successor with explicit reclassification; it must not disguise prior failures.

Suggested initial ceiling: one initial attempt, one same-tier repair, one high-tier attempt, then stop with evidence. An infrastructure retry is separately bounded and counted in total workflow cost; it must not create unlimited free retries outside the attempt ceiling. Cancelled or timed-out external operations require reconciliation before retry.

Escalate earlier for discovered high-complexity requirements, violated authority/data invariants, or a verifier showing the chosen model lacks needed capabilities. Do not wait for two predictable failures. Conversely, a Gradle dependency download outage needs environment repair, not flagship reasoning. If no eligible high route is available or affordable, persist `blocked` and explain the missing condition.

Example audit event:

```json
{
  "event": "task.escalation_requested",
  "taskId": "spell-networking",
  "fromAttempt": 2,
  "requestedTier": "high",
  "requestedEffort": "high",
  "reason": "two_consecutive_implementation_failures",
  "verificationIds": ["check-a1", "check-a2"],
  "handoffArtifactId": "handoff-3",
  "executionState": "awaiting_approval"
}
```

## Handoff packet and durable workflow continuity

An escalation must preserve useful state without forwarding the entire worker conversation:

```ts
interface HandoffPacket {
  taskId: string;
  taskRevision: number;
  goal: string;
  acceptanceCriteria: string[];
  constraints: string[];
  environment: Record<string, string>;
  baseCommit?: string;
  currentArtifactRefs: string[];
  diffArtifactRef?: string;
  skillLocks: { id: string; digest: string; profileDigest: string }[];
  attempts: {
    id: string;
    routeDecisionId: string;
    changeSummary: string;
    verificationIds: string[];
    diagnosticExcerpt: string;
    rejectedHypotheses: string[];
  }[];
  unresolved: string[];
  nextCheckIds: string[];
  remainingAttempts: number;
  remainingCostMicros?: string;
}
```

Facts require evidence; rejected hypotheses remain hypotheses. Record actual changes and checks, not invented internal reasoning. Keep the packet bounded and reference larger artifacts. A new provider must receive project constraints and tool permissions through its own host adapter; those are not inherited from prose in the handoff.

## Usage normalization and cache economics

Extend usage without breaking current displayed totals:

```ts
interface NormalizedUsage {
  inputTokensTotal: number | null;
  inputUncachedTokens: number | null;
  inputCacheReadTokens: number | null;
  inputCacheWriteTokens: number | null;
  inputCacheWriteByTtl?: Record<string, number>;
  outputTokensTotal: number | null;
  reasoningTokens: number | null; // May be a subset of output; never add blindly.
  complete: boolean;
  providerRequestId?: string;
}
```

Provider adapters own category semantics. Claude total input is uncached + cache-read + cache-creation input. OpenAI read/write counts are subsets of total input where reported: ordinary input = total minus reads minus writes; price TTL write components once. Older profiles may omit write categories. Preserve null for unknown usage and validate profile-specific absence semantics. A closed stream alone does not establish complete usage. See [Claude caching usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [OpenAI caching usage](https://developers.openai.com/api/docs/guides/prompt-caching).

Caching reduces repeated input processing/billing when applicable; it does not expand a context window. A new model/provider may need a fresh cache and skill transfer. Score a move using total expected completion cost, including transfer and repair, not just advertised per-token input price. Reuse a warm route only among routes that satisfy the task's quality requirements.

For concurrent workers, reserve each admitted attempt transactionally against provider, workflow and task caps. Workflow planning must leave room for verification, integration and a high-tier fallback, or explicitly report that fallback is unaffordable. Do not pre-reserve the same dollars twice: workflow envelopes constrain the sum of child spend/reservations rather than creating duplicate provider charges. On cancellation, keep the existing conservative accounting for uncertain usage.

## Initial skill library

Build a small library with clear boundaries before adding breadth:

| Skill                               | Typical route guidance                         | Important contract                                                               |
| ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `json-model-blockstate-boilerplate` | Deterministic or evaluated low/low             | Exact resource schema, IDs, references and runtime load checks                   |
| `paper-event-listener-generator`    | Medium/medium                                  | Actual Paper API version, event semantics, cancellation and thread rules         |
| `minecraft-fabric-mixin-debug`      | High/high preference, medium floor             | Actual mappings/descriptors, startup/runtime reproduction                        |
| `nms-packet-handling`               | High/high for version-sensitive diagnosis      | Server authority, packet bounds, version lock and malformed input checks         |
| `gradle-build-triage-and-log-scrub` | Deterministic extraction; medium for diagnosis | Causal excerpt, artifact reference, secret redaction, environment classification |
| `mod-architecture-review`           | Medium/high or high/high by coupling           | Explicit contracts, invariant review and migration impact                        |
| `server-performance-profiling`      | Medium/medium initially                        | Authorized measurement environment, baseline and reproducible workload           |
| `repo-conventions`                  | No independent downgrade entitlement           | Applicable AGENTS.md/CLAUDE.md and repository rules with source paths            |

These are proposed packages, not installed skills. Never infer Java, Minecraft, loader, mappings or server versions from the skill's title. Repository instruction discovery remains a host responsibility even when a conventions skill explains the workflow.

## Evaluation and failure cases to cover

Before activating live routing, verify the following behaviors with meaningful fixtures and state-transition tests:

- A strong generation skill plus semantic checks can qualify medium → low only for the evaluated cohort; a high reasoning floor survives skill retrieval.
- Unknown/incompatible versions, incomplete verifiers, stale evidence and self-claimed metrics cannot authorize a downgrade.
- Tool/effort incompatibility, insufficient context, unknown protected pricing and user ceilings exclude candidates with visible reason codes.
- A cheap model with repeated repairs can rank more expensive than a balanced model; cache hits do not override quality gates.
- Two distinct failed repair cycles produce one high escalation; duplicate checks, sibling failures and environment outages do not corrupt the streak.
- Skills compose without cycles, conflicting permissions, duplicate context or silent package shadowing; locked resources remain reproducible after local edits.
- Large catalogs and references stay bounded; mandatory facts survive compaction; a missing diagnostic root cause can be retrieved in a bounded follow-up.
- Cache and reasoning categories reconcile correctly, including interrupted streams, missing usage and concurrent reservations.
- Stale approvals, expiring leases, restart recovery, cancellation and duplicate API delivery cannot produce duplicate or unapproved work.

Release a policy only after held-out quality and total workflow cost support it. The system should be able to explain, in one short sentence, why a task used a model and skill combination: **“Balanced/medium: ordinary logic change; the skill is compatible, but low-tier behavior has not been qualified.”** Or: **“High/high: two verified repair failures; original artifacts and checks preserved.”**
