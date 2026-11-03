"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentView, TerminalDispatchView } from "@/lib/types";
import type {
  TerminalBridge,
  TerminalEngine,
  TerminalState,
  TerminalEvent,
} from "@/lib/terminal-types";
import {
  Settings2,
  Play,
  Square,
  Copy,
  Pin,
  ChevronDown,
  GripVertical,
  Maximize2,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
export function TerminalSurface({
  agentId,
  bridge,
  onState,
  fontSize = 15,
  actions,
}: {
  agentId: string;
  bridge: TerminalBridge;
  onState: (state: TerminalState) => void;
  fontSize?: number;
  actions?: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const state = useRef<TerminalState>({ agentId, state: "stopped" });
  const callback = useRef(onState);
  callback.current = onState;
  const term = useRef<import("@xterm/xterm").Terminal | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false,
      cleanup = () => {};
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
      .then(async ([{ Terminal }, { FitAddon }]) => {
        if (cancelled || !root.current) return;
        const terminal = new Terminal({
          cursorBlink: true,
          fontFamily: "Consolas, monospace",
          fontSize,
          lineHeight: 1.4,
          scrollback: 20000,
          allowProposedApi: false,
          theme: {
            background: "#1c1b1a",
            foreground: "#ededed",
            cursor: "#ff8a35",
            selectionBackground: "#87401c",
          },
          screenReaderMode: true,
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(root.current);
        term.current = terminal;
        // Consume clipboard/file-transfer escapes. No link/image addons or remote content.
        const handlers = [8, 52, 1337].map((code) =>
          terminal.parser.registerOscHandler(code, () => true),
        );
        let initialized = false;
        const queued: TerminalEvent[] = [];
        function receive(next: TerminalState) {
          state.current = next;
          callback.current(next);
        }
        function apply(event: TerminalEvent) {
          if (event.type === "data") {
            receive(event);
            terminal.write(event.data || "");
          } else if (event.type === "state") {
            receive(event);
            resize();
          }
        }
        const remove = bridge.onEvent((event) => {
          if (event.agentId !== agentId) return;
          if (!initialized) queued.push(event);
          else apply(event);
        });
        const typed = terminal.onData((data) => {
          const s = state.current;
          if (s.state === "running" && s.token)
            void bridge
              .input(agentId, s.token, data)
              .catch((e) => setError(e.message));
        });
        const resize = () => {
          if (!root.current?.clientWidth || !root.current.clientHeight) return;
          fit.fit();
          const s = state.current;
          if (s.state === "running" && s.token)
            void bridge
              .resize(
                agentId,
                s.token,
                Math.min(400, Math.max(2, terminal.cols)),
                Math.min(200, Math.max(2, terminal.rows)),
              )
              .catch(() => {});
        };
        const observer = new ResizeObserver(resize);
        observer.observe(root.current);
        cleanup = () => {
          remove();
          typed.dispose();
          observer.disconnect();
          handlers.forEach((handler) => handler.dispose());
          terminal.dispose();
          term.current = null;
        };
        try {
          const snapshot = await bridge.snapshot(agentId);
          if (!cancelled) {
            receive(snapshot);
            terminal.write(snapshot.data || "");
            initialized = true;
            for (const event of queued)
              if (
                event.sequence == null ||
                event.sequence > (snapshot.sequence ?? -1)
              )
                apply(event);
            queued.length = 0;
            resize();
          }
        } catch (e) {
          if (!cancelled) {
            initialized = true;
            queued.forEach(apply);
            queued.length = 0;
            setError((e as Error).message);
          }
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [agentId, bridge, fontSize]);
  return (
    <>
      <div
        className="terminal-surface"
        ref={root}
        aria-label="Agent terminal"
        onClick={() => term.current?.focus()}
      />
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      <div className="terminal-footer">
        <div className="terminal-actions">{actions}</div>
        <div
          className="terminal-key-controls"
          aria-label="Terminal keyboard controls"
        >
          <button
            className="secondary"
            onClick={() => term.current?.scrollToBottom()}
          >
            Latest
          </button>
          {[
            ["↑", "\x1b[A"],
            ["↓", "\x1b[B"],
            ["Enter", "\r"],
          ].map(([label, key]) => (
            <button
              key={label}
              className="secondary"
              onClick={() => {
                const current = state.current;
                if (current.state === "running" && current.token)
                  void bridge
                    .input(agentId, current.token, key)
                    .catch((e) => setError(e.message));
              }}
            >
              {label}
            </button>
          ))}
          <button
            className="terminal-copy text-button"
            aria-label="Copy selection"
            title="Copy selection"
            onClick={() => {
              const selection = term.current?.getSelection();
              if (selection) void navigator.clipboard.writeText(selection);
            }}
          >
            <Copy size={14} />
          </button>
        </div>
      </div>
    </>
  );
}
export function TerminalPanel({
  agent,
  dispatch,
  onRetry,
  onEdit,
  onPin,
  onCollapse,
  onFocus,
  onMove,
  collapsed,
  pinned,
  fontSize,
}: {
  agent: AgentView;
  dispatch?: TerminalDispatchView;
  onRetry?: (proposalId: string) => Promise<void>;
  onEdit: () => void;
  onPin: () => void;
  onCollapse: () => void;
  onFocus: () => void;
  onMove: (direction: number) => void;
  collapsed: boolean;
  pinned: boolean;
  fontSize?: number;
}) {
  const [bridge, setBridge] = useState<TerminalBridge>();
  const [state, setState] = useState<TerminalState>({
    agentId: agent.id,
    state: "stopped",
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [setup, setSetup] = useState(false),
    [progress, setProgress] = useState<number | null>(null);
  const engine = agent.engine as TerminalEngine;
  useEffect(() => {
    setBridge(window.vizorDesktop?.terminals);
  }, []);
  useEffect(
    () =>
      bridge?.onEvent((event) => {
        if (event.type === "install" && event.engine === engine)
          setProgress(event.progress ?? null);
        if (event.type === "state" && event.agentId === agent.id)
          setState(event);
      }),
    [bridge, engine, agent.id],
  );
  async function start() {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      let next = await bridge.start(agent.id);
      if (
        next.conflict &&
        confirm(
          "Another coding agent is open in this project. Their edits can conflict. Start this agent too?",
        )
      )
        next = await bridge.start(agent.id, true);
      if (!next.conflict) setState(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function prepare(forceInstall = false) {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      const tools = await bridge.tools();
      if (forceInstall) {
        const current = await bridge.snapshot(`setup-${engine}`);
        if (current.state === "running" && current.token)
          await bridge.stop(current.agentId, current.token);
      }
      if (forceInstall || !tools.find((t) => t.engine === engine)?.installed)
        await bridge.install(engine);
      if (engine === "claude-code") {
        // Setup must use the worker's own session, so completing its prompts
        // also unblocks delivery to that worker.
        let next = await bridge.start(agent.id);
        if (
          next.conflict &&
          confirm(
            "Another coding agent is open in this project. Start this agent too?",
          )
        )
          next = await bridge.start(agent.id, true);
        if (!next.conflict) setState(next);
        return;
      }
      await bridge.setup(engine);
      setSetup(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function stop(setupSession = false) {
    if (!bridge) return;
    try {
      const current = setupSession
        ? await bridge.snapshot(`setup-${engine}`)
        : state;
      if (current.token && current.state === "running")
        await bridge.stop(current.agentId, current.token);
      if (setupSession) setSetup(false);
      else setState({ ...state, state: "stopped" });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const folder = agent.projectPath?.split(/[\\/]/).filter(Boolean).pop();
  const billingNote =
    engine === "codex"
      ? "Usage and permissions are managed inside Codex. This terminal uses the Codex account signed in on this computer."
      : "Uses the Anthropic Console key saved in Vizor, with a separate Claude Code profile. Terminal API charges appear in Claude Code; Vizor spending limits do not cover them.";
  const actions = (
    <>
      {state.state === "running" ? (
        <>
          <button
            className="secondary"
            disabled={!bridge}
            onClick={() =>
              void bridge
                ?.interrupt(agent.id, state.token!)
                .catch((e) => setError(e.message))
            }
          >
            Interrupt
          </button>
          <button className="secondary" onClick={() => void stop()}>
            <Square size={12} /> Stop
          </button>
        </>
      ) : (
        <button
          className="secondary"
          onClick={() => void start()}
          disabled={!bridge || busy || agent.paused}
        >
          <Play size={13} /> Resume
        </button>
      )}
      <button
        className="text-button"
        disabled={!bridge || busy}
        onClick={() => void prepare()}
      >
        {busy
          ? progress == null
            ? "Preparing…"
            : `Downloading ${progress}%`
          : engine === "claude-code"
            ? "Set up Claude Code"
            : "Set up / sign in"}
      </button>
    </>
  );
  return (
    <section
      className={`agent-panel terminal-panel ${collapsed ? "collapsed-panel" : ""}`}
      aria-label={`${agent.name} panel`}
    >
      <div className="agent-panel-header">
        <button
          className="icon-button panel-grip"
          aria-label={`Move ${agent.name} panel`}
          title="Drag to move · Left/Right keys to reorder"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              onMove(event.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
          <GripVertical size={16} />
        </button>
        <div className="terminal-title">
          <strong>{agent.name}</strong>
          <small title={`${agent.projectPath}\n${billingNote}`}>
            <span
              className={`status-dot ${state.state === "running" ? "on" : ""}`}
              aria-hidden="true"
            />
            {state.state === "running"
              ? state.inputReady
                ? "Terminal ready"
                : "Process open · activity not verified"
              : "Stopped"}
            {state.state === "stopped" && state.exitCode
              ? ` · exit ${state.exitCode}`
              : ""}
            <span className="terminal-meta">
              {engine === "codex" ? "Codex" : "Claude Code"}
              {folder ? ` · ${folder}` : ""}
            </span>
          </small>
        </div>
        <div className="panel-controls">
          <button
            className="icon-button"
            aria-label={`Pin ${agent.name}`}
            aria-pressed={pinned}
            onClick={onPin}
          >
            <Pin size={14} />
          </button>
          <button
            className="icon-button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${agent.name}`}
            onClick={onCollapse}
          >
            <ChevronDown size={14} />
          </button>
          <button
            className="icon-button"
            aria-label={`Focus ${agent.name}`}
            title="Expand conversation"
            onClick={onFocus}
          >
            <Maximize2 size={15} />
          </button>
          <button
            className="icon-button"
            aria-label={`Settings for ${agent.name}`}
            onClick={onEdit}
          >
            <Settings2 size={15} />
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          {dispatch && dispatch.status !== "failed" && (
            <div className="terminal-task-status" role="status">
              <strong>
                {dispatch.status === "ready"
                  ? "Approved · waiting to send"
                  : dispatch.status === "claimed"
                    ? "Opening terminal and sending task…"
                    : dispatch.status === "reported"
                      ? dispatch.questions && dispatch.questions !== "[]"
                        ? "Question sent to Orchestrator · waiting for answer"
                        : "Agent report received · review in Orchestrator"
                      : "Task submitted · waiting for agent report"}
              </strong>
              {dispatch.error && <span>{dispatch.error}</span>}
              {dispatch.status === "ready" && onRetry && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await onRetry(dispatch.proposalId);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Retry delivery
                </button>
              )}
              <details className="terminal-assignment">
                <summary>View assigned task</summary>
                <pre>{dispatch.text}</pre>
              </details>
            </div>
          )}
          {!bridge ? (
            <div className="terminal-placeholder">
              Open the Windows desktop app to use this terminal agent.
            </div>
          ) : (
            <TerminalSurface
              agentId={agent.id}
              fontSize={fontSize}
              bridge={bridge}
              onState={setState}
              actions={actions}
            />
          )}
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </>
      )}
      {setup && bridge && (
        <div className="terminal-setup">
          <div className="panel-heading">
            <strong>
              {engine === "codex" ? "Codex" : "Claude Code"} setup
            </strong>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void prepare(true)}
            >
              Install verified version
            </button>
            <button className="secondary" onClick={() => void stop(true)}>
              Close setup
            </button>
          </div>
          <TerminalSurface
            agentId={`setup-${engine}`}
            fontSize={fontSize}
            bridge={bridge}
            onState={() => {}}
          />
        </div>
      )}
    </section>
  );
}
