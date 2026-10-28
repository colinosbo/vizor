import { describe, expect, it } from "vitest";
import { overlayAgent } from "../src/components/use-workspace";
import type { AgentView, RunPatch } from "../src/lib/types";
const base: AgentView = {
  id: "agent-a",
  name: "Writer",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  systemPrompt: "Write",
  temperature: 0.7,
  maxTokens: 1024,
  color: "mint",
  icon: "pen",
  demo: false,
  paused: false,
  archived: false,
  conversation: {
    id: "conversation",
    activeRunId: null,
    messages: [],
    runs: [],
  },
};
const patch: RunPatch = {
  agentId: "agent-a",
  runId: "run-a",
  assistantId: "assistant-a",
  provider: "anthropic",
  model: base.model,
  text: "A growing answer",
  status: "running",
  inputTokens: 12,
  outputTokens: null,
  cost: null,
  usageComplete: false,
  errorCode: null,
  createdAt: "2026-10-27T20:00:00.000Z",
};
describe("live workspace reconciliation", () => {
  it("leaves unaffected agents unchanged", () => {
    expect(overlayAgent(base, undefined)).toBe(base);
  });
  it("handles cumulative replay without duplicating text or assistant messages", () => {
    const first = overlayAgent(base, patch);
    const next = overlayAgent(first, {
      ...patch,
      text: "A growing answer continues",
      outputTokens: 8,
      cost: 0.000156,
    });
    expect(next.conversation.messages).toHaveLength(1);
    expect(next.conversation.runs).toHaveLength(1);
    expect(next.conversation.messages[0].text).toBe(
      "A growing answer continues",
    );
    expect(next.conversation.runs[0].outputTokens).toBe(8);
  });
  it("ignores late stream events after the canonical run is terminal", () => {
    const live = overlayAgent(base, patch);
    const finished: AgentView = {
      ...live,
      conversation: {
        ...live.conversation,
        activeRunId: null,
        runs: live.conversation.runs.map((run) => ({
          ...run,
          status: "stopped",
        })),
      },
    };
    expect(overlayAgent(finished, { ...patch, text: "stale text" })).toBe(
      finished,
    );
    expect(finished.conversation.activeRunId).toBeNull();
  });
});
