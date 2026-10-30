"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Code2,
  GripVertical,
  Maximize2,
  Minus,
  Pin,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Zap,
  PenLine,
} from "lucide-react";
import type { AgentView, ProviderInfo, PublicMessage } from "@/lib/types";
import { AgentIcon, Dialog, Message, money, ProviderGlyph } from "./ui";
export function agentStatus(agent: AgentView, pending = false) {
  return agent.archived
    ? "Archived"
    : agent.paused
      ? "Paused"
      : agent.conversation.activeRunId || pending
        ? "Thinking"
        : agent.conversation.runs.at(-1)?.status === "error"
          ? "Error · ready to retry"
          : ["stopped", "interrupted"].includes(
                agent.conversation.runs.at(-1)?.status ?? "",
              )
            ? "Stopped"
            : agent.conversation.runs.at(-1)?.status === "complete"
              ? "Waiting for you"
              : "Ready";
}
export function AgentPanel({
  agent,
  provider,
  modelName,
  compact,
  pinned,
  collapsed,
  pending,
  error,
  onEdit,
  onPin,
  onCollapse,
  onFocus,
  onMove,
  send,
  stop,
  notify,
  coordinator = false,
}: {
  agent: AgentView;
  provider: ProviderInfo;
  modelName: string;
  compact: boolean;
  pinned: boolean;
  collapsed: boolean;
  pending: boolean;
  error?: string;
  onEdit: () => void;
  onPin: () => void;
  onCollapse: () => void;
  onFocus: () => void;
  onMove: (direction: number) => void;
  send: (
    text: string,
    mode?: "send" | "edit" | "regenerate",
    messageId?: string,
  ) => Promise<void>;
  stop: () => Promise<void>;
  notify: (value: string) => void;
  coordinator?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [edit, setEdit] = useState<PublicMessage | null>(null);
  const [editText, setEditText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const running = !!agent.conversation.activeRunId || pending;
  const blocked =
    running || agent.paused || agent.archived || !provider.connected;
  const messages = agent.conversation.messages;
  const last = agent.conversation.runs.at(-1);
  const state = agentStatus(agent, pending);
  useEffect(() => {
    const area = scroll.current;
    if (area && area.scrollHeight - area.scrollTop - area.clientHeight < 180)
      area.scrollTo({ top: area.scrollHeight, behavior: "instant" });
  }, [messages]);
  function submit(
    text = draft,
    mode: "send" | "edit" | "regenerate" = "send",
    id?: string,
  ) {
    if (blocked || (mode !== "regenerate" && !text.trim())) return;
    setDraft("");
    setEdit(null);
    void send(text, mode, id);
  }
  return (
    <section
      className={`agent-panel ${compact ? "compact-panel" : "focus-panel"} ${collapsed ? "collapsed-panel" : ""} ${coordinator ? "coordinator-panel" : ""}`}
      aria-label={`${agent.name} panel`}
    >
      <header className="panel-top">
        <button
          className="icon-button panel-grip"
          aria-label={`Move ${agent.name} panel`}
          title="Drag to move · Left/Right keys to reorder"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              onMove(e.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
          <GripVertical size={16} />
        </button>
        <span className={`agent-symbol ${agent.color}`}>
          <AgentIcon icon={agent.icon} />
        </span>
        <div className="panel-agent-title">
          <h2>{agent.name}</h2>
          <div>
            <ProviderGlyph id={agent.provider} size={12} />
            <span>{modelName}</span>
            <span className={`panel-status ${running ? "working" : ""}`}>
              <span className="tiny-dot" />
              {state}
            </span>
          </div>
        </div>
        <div className="panel-controls">
          <button
            className={`icon-button ${pinned ? "pinned" : ""}`}
            aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.name}`}
            title={pinned ? "Unpin agent" : "Pin agent"}
            onClick={onPin}
          >
            <Pin size={14} />
          </button>
          <button
            className="icon-button"
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${agent.name}`}
            title={collapsed ? "Expand panel" : "Collapse panel"}
            onClick={onCollapse}
          >
            {collapsed ? <Plus size={15} /> : <Minus size={15} />}
          </button>
          {compact && (
            <button
              className="icon-button"
              aria-label={`Focus ${agent.name}`}
              title="Focus agent"
              onClick={onFocus}
            >
              <Maximize2 size={14} />
            </button>
          )}
          <button
            className="icon-button"
            aria-label={
              coordinator
                ? "Orchestrator settings"
                : `Agent settings${compact ? ` for ${agent.name}` : ""}`
            }
            title="Agent settings"
            onClick={onEdit}
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>
      {!collapsed && (
        <>
          {error && (
            <div className="panel-error" role="alert">
              {error}
            </div>
          )}
          <div
            className="chat-scroll"
            ref={scroll}
            role="log"
            aria-label={`Conversation with ${agent.name}`}
            aria-live="off"
          >
            {!messages.length ? (
              <div className="chat-empty">
                <div className="orbital-mark">
                  <span />
                  <span />
                  <Sparkles size={compact ? 22 : 27} />
                </div>
                <div className="eyebrow">
                  {coordinator ? "START WITH A GOAL" : "READY FOR YOUR TASK"}
                </div>
                <h3>
                  {coordinator
                    ? "What should we work on?"
                    : "What’s on your mind?"}
                </h3>
                <p>
                  {coordinator ? (
                    "Describe what you want to build, the project, and what success looks like. I’ll help break it into tasks for your selected agents."
                  ) : (
                    <>
                      {compact ? (
                        "Start a conversation. Give this agent a direction."
                      ) : (
                        <>
                          A rough idea, a tricky question, a blank page.
                          <br />
                          Start anywhere.
                        </>
                      )}
                    </>
                  )}
                </p>
                {!compact && (
                  <div className="starter-prompts">
                    {[
                      {
                        icon: PenLine,
                        title: "Find the right words",
                        text: "Help me turn a rough idea into a clear piece of writing. Ask me what I want to say and who it’s for.",
                      },
                      {
                        icon: Code2,
                        title: "Build something useful",
                        text: "Help me work through the requirements for something useful I want to build.",
                      },
                      {
                        icon: Zap,
                        title: "Work through an idea",
                        text: "Help me think through an idea. Ask focused questions before offering suggestions.",
                      },
                    ].map((p) => (
                      <button key={p.title} onClick={() => setDraft(p.text)}>
                        <p.icon size={17} />
                        <span>{p.title}</span>
                        <ArrowUp size={14} className="external-arrow" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="message-list">
                {messages.map((message, index) => (
                  <Message
                    key={message.id}
                    message={message}
                    agent={agent}
                    providerLabel={provider.label}
                    canEdit={!blocked}
                    canRegenerate={index === messages.length - 1 && !blocked}
                    onEdit={() => {
                      setEdit(message);
                      setEditText(message.text);
                    }}
                    onRegenerate={() => submit("", "regenerate")}
                    notify={notify}
                  />
                ))}
                <div ref={end} />
              </div>
            )}
          </div>
          <div className="composer-area">
            {agent.paused ? (
              <div className="panel-hint">
                Agent paused. Resume it from agent settings.
              </div>
            ) : !provider.connected ? (
              <div className="panel-hint">
                Connect {provider.label} in API keys to continue.
              </div>
            ) : null}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label className="sr-only" htmlFor={`message-${agent.id}`}>
                Message {agent.name}
              </label>
              <textarea
                id={`message-${agent.id}`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Message ${agent.name}…`}
                rows={compact ? 1 : 2}
                maxLength={32000}
                disabled={agent.paused || !provider.connected}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              <div className="composer-bottom">
                <span>
                  <ProviderGlyph id={agent.provider} size={14} />
                  <span>{compact ? provider.label : modelName}</span>
                  {last && (
                    <>
                      <span className="composer-divider" />
                      <span className="panel-live-usage">
                        {(
                          (last.inputTokens ?? 0) + (last.outputTokens ?? 0)
                        ).toLocaleString()}{" "}
                        tokens ·{" "}
                        {last.cost == null
                          ? "Cost unavailable"
                          : `${money(last.cost)} est.`}
                        {last.usageComplete ? "" : " · partial"}
                      </span>
                    </>
                  )}
                </span>
                {running ? (
                  <button
                    type="button"
                    className="send-button stop-button"
                    aria-label="Stop response"
                    onClick={() => void stop().catch((e) => notify(e.message))}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="submit"
                    aria-label="Send message"
                    disabled={blocked || !draft.trim()}
                  >
                    <ArrowUp size={19} />
                  </button>
                )}
              </div>
            </form>
            {!compact && (
              <div className="composer-meta">
                <span>Enter to send · Shift + Enter for a new line</span>
                <span>
                  <ShieldCheck size={12} />
                  Only shared with {provider.label}
                </span>
              </div>
            )}
          </div>
        </>
      )}
      {edit && (
        <Dialog title="Edit & resend" onClose={() => setEdit(null)}>
          <p>
            This replaces the message and removes all responses after it from
            the active conversation.
          </p>
          <label>
            Message
            <textarea
              aria-label="Message"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={6}
              maxLength={32000}
            />
          </label>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setEdit(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={!editText.trim()}
              onClick={() => submit(editText, "edit", edit.id)}
            >
              Replace & resend
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
