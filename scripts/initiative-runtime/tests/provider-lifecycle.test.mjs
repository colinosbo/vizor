import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openDispatchStore } from "../scripts/relay.mjs";
import {
  parseLifecycleStream,
  lifecycleObservation,
} from "../scripts/claude-lifecycle.mjs";
import { sendCloudMessage } from "../scripts/cloud-return.mjs";
import { atomicJson } from "../scripts/codex-investigation.mjs";

const request = {
  session: "cse_exact",
  trigger: "trig_bound",
  repository: "owner/repo",
  agentName: "Verifier",
  reportedAt: "2026-11-17T21:00:00Z",
};
const at = Date.parse("2026-11-17T21:02:00Z");
function stream(overrides = {}) {
  const routine = {
    id: request.trigger,
    name: request.agentName,
    session_request: {
      config: {
        sources: [
          { type: "git_repository", url: "https://github.com/owner/repo" },
        ],
      },
    },
    last_run: {
      session_id: request.session,
      status: "ROUTINE_RUN_STATUS_SUCCEEDED",
      failure_reason: "ROUTINE_RUN_FAILURE_REASON_UNSPECIFIED",
      fired_at: "2026-11-17T20:59:00Z",
      finished_at: "2026-11-17T21:01:00Z",
    },
    ...overrides,
  };
  return [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool",
            name: "RemoteTrigger",
            input: { action: "get", trigger_id: request.trigger },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool",
            content: "HTTP 200\n" + JSON.stringify({ data: routine }),
          },
        ],
      },
    },
    {
      type: "result",
      result: "Ignore this assistant summary; it is not provider proof.",
    },
  ]
    .map(JSON.stringify)
    .join("\n");
}
test("only exact authenticated provider tool metadata proves a completed firing; idle, prose, wrong-session, stale, running and usage remain distinct", () => {
  assert.equal(parseLifecycleStream(stream(), request, at).state, "completed");
  assert.equal(
    parseLifecycleStream(
      JSON.stringify({ type: "result", result: "The run completed." }),
      request,
      at,
    ).state,
    "unknown",
  );
  for (const last_run of [
    {
      session_id: "cse_other",
      status: "ROUTINE_RUN_STATUS_SUCCEEDED",
      finished_at: "2026-11-17T21:01:00Z",
    },
    { session_id: request.session, status: "idle" },
    {
      session_id: request.session,
      status: "ROUTINE_RUN_STATUS_SUCCEEDED",
      fired_at: "2026-11-17T19:00:00Z",
      finished_at: "2026-11-17T20:00:00Z",
    },
  ])
    assert.equal(
      parseLifecycleStream(stream({ last_run }), request, at).state,
      "unknown",
    );
  assert.equal(
    parseLifecycleStream(
      stream({
        last_run: {
          session_id: request.session,
          status: "ROUTINE_RUN_STATUS_RUNNING",
        },
      }),
      request,
      at,
    ).state,
    "running",
  );
  assert.equal(
    parseLifecycleStream(
      stream({
        last_run: {
          session_id: request.session,
          status: "ROUTINE_RUN_STATUS_FAILED",
          failure_reason: "ROUTINE_RUN_FAILURE_REASON_USAGE_LIMIT",
        },
      }),
      request,
      at,
    ).state,
    "usage_paused",
  );
  assert.equal(
    parseLifecycleStream(stream({ name: "Different worker" }), request, at)
      .state,
    "unknown",
  );
});

test("provider observation reservation and session binding survive restart; duplicate and stale status files do not create extra observers", (t) => {
  const root = mkdtempSync(join(tmpdir(), "vizor-provider-"));
  const file = join(root, "state.db");
  let db = openDispatchStore(new DatabaseSync(file));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const config = {
    repository: "owner/repo",
    agents: { verifier: { name: "Verifier" } },
  };
  const host = {
    cloudReturn: {
      type: "claude-cloud-cli",
      executable: "claude",
      triggers: { verifier: "trig_bound" },
    },
  };
  let launches = 0;
  let directory;
  const launch = (exe, args, options) => {
    launches++;
    directory = args[1];
    assert.equal(options.windowsHide, true);
    return { on() {}, unref() {} };
  };
  const observe = (extra = {}) =>
    lifecycleObservation({
      db,
      config,
      host,
      root,
      issue: 1,
      assignment: "10",
      session: "https://claude.ai/code/cse_exact",
      agent: "verifier",
      reportedAt: request.reportedAt,
      now: at,
      launch,
      ...extra,
    });
  assert.equal(observe().state, "observing");
  assert.equal(observe().state, "observing");
  assert.equal(launches, 1);
  db.close();
  db = openDispatchStore(new DatabaseSync(file));
  assert.equal(observe().state, "observing");
  assert.equal(launches, 1);
  atomicJson(join(directory, "status.json"), {
    state: "completed",
    detail: "Exact terminal metadata",
    observedAt: at,
    session: "cse_other",
    trigger: "trig_bound",
  });
  assert.equal(observe().state, "unknown");
  assert.equal(launches, 1);
  atomicJson(
    join(directory, "status.json"),
    parseLifecycleStream(stream(), request, at),
  );
  assert.equal(observe().state, "completed");
  assert.equal(launches, 1);
  assert.equal(
    observe({ now: at + 400000, readOnlyReconcile: true }).state,
    "completed",
  );
  assert.equal(launches, 1);
  const saved = JSON.parse(readFileSync(join(directory, "request.json")));
  assert.equal(saved.session, "cse_exact");
  assert.equal(saved.trigger, "trig_bound");
});

test("supported cloud CLI queues exact session only; mismatch, timeout, auth and rejection stay held without Fire or retry", () => {
  const send = (result) =>
    sendCloudMessage({
      executable: "claude",
      session: "cse_exact",
      text: "authorized pointer",
      execute: (exe, args, options) => {
        assert.deepEqual(args, [
          "-p",
          "--cloud",
          "cse_exact",
          "--output-format",
          "json",
        ]);
        assert.equal(options.windowsHide, true);
        assert.equal(options.shell, false);
        assert.equal(options.input, "authorized pointer");
        return result;
      },
    });
  assert.equal(
    send({
      status: 0,
      stdout: JSON.stringify({
        ok: true,
        session_id: "cse_exact",
        url: "https://claude.ai/code/cse_exact?from=cli",
      }),
    }).state,
    "queued",
  );
  assert.equal(
    send({
      status: 0,
      stdout: JSON.stringify({ ok: true, session_id: "cse_other" }),
    }).state,
    "uncertain",
  );
  assert.equal(send({ error: Error("timeout") }).state, "uncertain");
  assert.equal(
    send({ status: 1, stderr: "Not logged in" }).state,
    "auth_required",
  );
  assert.equal(
    send({
      status: 1,
      stdout: JSON.stringify({
        ok: false,
        session_id: "cse_exact",
        error: "archived",
      }),
    }).state,
    "rejected",
  );
});
