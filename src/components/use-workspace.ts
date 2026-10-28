"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentView,
  LiveEvent,
  ProviderModel,
  RunPatch,
  Workspace,
  WorkspaceLayout,
} from "@/lib/types";
import { defaultLayout } from "@/lib/layout";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(result.message ?? "Please try again.", response.status);
  return result;
}
export type ModelList = {
  models: ProviderModel[];
  fallback: boolean;
  message?: string;
};
export function overlayAgent(
  agent: AgentView,
  patch: RunPatch | undefined,
): AgentView {
  if (!patch) return agent;
  const old = agent.conversation.runs.find((run) => run.id === patch.runId);
  if (old && old.status !== "running") return agent;
  const message = {
    id: patch.assistantId,
    role: "assistant",
    text: patch.text,
    status: "streaming",
    createdAt: patch.createdAt,
  };
  const run = {
    id: patch.runId,
    assistantId: patch.assistantId,
    provider: patch.provider,
    model: patch.model,
    status: patch.status,
    inputTokens: patch.inputTokens,
    outputTokens: patch.outputTokens,
    cost: patch.cost,
    usageComplete: patch.usageComplete,
    errorCode: patch.errorCode,
  };
  return {
    ...agent,
    conversation: {
      ...agent.conversation,
      activeRunId: patch.runId,
      messages: agent.conversation.messages.some(
        (m) => m.id === patch.assistantId,
      )
        ? agent.conversation.messages.map((m) =>
            m.id === patch.assistantId ? { ...m, text: patch.text } : m,
          )
        : [...agent.conversation.messages, message],
      runs: old
        ? agent.conversation.runs.map((r) => (r.id === patch.runId ? run : r))
        : [...agent.conversation.runs, run],
    },
  };
}
export function useWorkspace() {
  const [data, setData] = useState<Workspace | null>(null);
  const [auth, setAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [live, setLive] = useState<Record<string, RunPatch>>({});
  const [layout, setLayout] = useState<WorkspaceLayout>(defaultLayout);
  const [saving, setSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<Record<string, ModelList>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({});
  const requests = useRef(new Map<string, AbortController>());
  const sequence = useRef(0);
  const saveQueue = useRef(Promise.resolve());
  const saveCount = useRef(0);
  const disposed = useRef(false);
  const reload = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const next = await api<Workspace>("workspace");
      if (id !== sequence.current || disposed.current) return next;
      setData(next);
      setAuth(false);
      if (!saveCount.current) setLayout(next.layout);
      setLive((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([agentId, patch]) => {
            const run = next.agents
              .find((a) => a.id === agentId)
              ?.conversation.runs.find((r) => r.id === patch.runId);
            return !run || run.status === "running";
          }),
        ),
      );
      return next;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuth(true);
        setData(null);
        setLive({});
      } else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    disposed.current = false;
    void reload();
    return () => {
      disposed.current = true;
      for (const request of requests.current.values()) request.abort();
    };
  }, [reload]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!data || auth) return;
    const feed = new EventSource("/api/events");
    feed.onopen = () => {
      setConnected(true);
      void reload();
    };
    feed.onerror = () => setConnected(false);
    feed.onmessage = (message) => {
      const event = JSON.parse(message.data) as LiveEvent;
      if (event.type === "change") void reload();
      else if (event.type === "run")
        setLive((old) => ({ ...old, [event.run.agentId]: event.run }));
      else {
        feed.close();
        setAuth(true);
        setData(null);
        for (const request of requests.current.values()) request.abort();
      }
    };
    return () => {
      feed.close();
      setConnected(false);
    };
  }, [!!data, auth, reload]);
  const providersKey = data?.providers
    .map((p) => `${p.id}:${p.connected}:${p.last4}`)
    .join("|");
  const refreshModels = useCallback(async (id: string) => {
    try {
      const list = await api<ModelList>(`providers/${id}/models`);
      setModels((old) => ({ ...old, [id]: list }));
    } catch (e) {
      setModels((old) => ({
        ...old,
        [id]: {
          models: old[id]?.models ?? [],
          fallback: true,
          message: (e as Error).message,
        },
      }));
    }
  }, []);
  useEffect(() => {
    for (const provider of data?.providers ?? [])
      if (provider.connected) void refreshModels(provider.id);
  }, [providersKey, refreshModels]);
  useEffect(() => {
    if (connected || !data) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [connected, !!data, reload]);
  const agents = useMemo(
    () =>
      data?.agents.map((agent) => overlayAgent(agent, live[agent.id])) ?? [],
    [data, live],
  );
  function updateLayout(next: WorkspaceLayout) {
    setLayout(next);
    saveCount.current++;
    setSaving(true);
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          await api("layout", "PATCH", next);
        } catch (e) {
          setError(`Layout not saved: ${(e as Error).message}`);
        } finally {
          saveCount.current--;
          if (!saveCount.current) {
            setSaving(false);
            await reload();
          }
        }
      });
  }
  async function send(
    agentId: string,
    text: string,
    mode: "send" | "edit" | "regenerate" = "send",
    messageId?: string,
  ) {
    if (requests.current.has(agentId)) return;
    const abort = new AbortController();
    requests.current.set(agentId, abort);
    setPending((old) => ({ ...old, [agentId]: true }));
    setChatErrors((old) => ({ ...old, [agentId]: "" }));
    try {
      const response = await fetch(`/api/agents/${agentId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: crypto.randomUUID(),
          mode,
          ...(mode !== "regenerate" ? { text } : {}),
          ...(messageId ? { messageId, confirm: true } : {}),
        }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error((await response.json()).message);
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          let at: number;
          while ((at = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, at);
            pending = pending.slice(at + 2);
            if (frame.startsWith("event: error")) {
              const raw = frame.match(/^data: (.+)$/m)?.[1];
              if (raw)
                setChatErrors((old) => ({
                  ...old,
                  [agentId]: JSON.parse(raw).message,
                }));
            }
          }
          if (done) break;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted)
        setChatErrors((old) => ({ ...old, [agentId]: (e as Error).message }));
    } finally {
      requests.current.delete(agentId);
      setPending((old) => ({ ...old, [agentId]: false }));
      await reload();
    }
  }
  async function stop(agent: AgentView) {
    if (agent.conversation.activeRunId)
      await api(`runs/${agent.conversation.activeRunId}/stop`, "POST");
    requests.current.get(agent.id)?.abort();
  }
  async function logout() {
    for (const request of requests.current.values()) request.abort();
    await api("auth/logout", "POST");
    setModels({});
    setLive({});
    setData(null);
    await reload();
  }
  return {
    data,
    agents,
    auth,
    loading,
    error,
    setError,
    notice,
    setNotice,
    layout,
    updateLayout,
    saving,
    connected,
    models,
    refreshModels,
    pending,
    chatErrors,
    reload,
    send,
    stop,
    logout,
  };
}
