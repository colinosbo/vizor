"use client";
import { useEffect, useRef } from "react";
import {
  Code2,
  Copy,
  PenLine,
  Pencil,
  RotateCcw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentView, PublicMessage } from "@/lib/types";
export const money = (value: number) =>
  `$${value.toFixed(value < 0.01 ? 5 : 3)}`;
export function Mark() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 10.5 18 4l13 6.5V25l-13 7L5 25V10.5Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      <path
        d="m10 13 8 13 8-13M18 26V14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export function ProviderGlyph({
  id,
  size = 20,
}: {
  id: string;
  size?: number;
}) {
  return id === "anthropic" ? (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        {Array.from({ length: 10 }, (_, i) => (
          <path key={i} d="M14 3v7" transform={`rotate(${i * 36} 14 14)`} />
        ))}
      </g>
    </svg>
  ) : (
    <span className="openai-glyph" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
        <path
          d="m14 2 10.4 6v12L14 26 3.6 20V8L14 2Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="m14 7 6 3.5v7L14 21l-6-3.5v-7L14 7Zm0 0v7l6 3.5M14 14 8 17.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
export function AgentIcon({
  icon,
  size = 17,
}: {
  icon: string;
  size?: number;
}) {
  const Icon =
    icon === "code"
      ? Code2
      : icon === "pen"
        ? PenLine
        : icon === "search"
          ? Search
          : Sparkles;
  return <Icon size={size} />;
}
export function useFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const all = () =>
      Array.from(
        element?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), textarea, input:not([disabled]), select, [href]",
        ) ?? [],
      );
    (
      element?.querySelector<HTMLElement>("textarea, input") ?? all()[0]
    )?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const items = all(),
          first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [ref]);
}
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="dialog-heading">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function Message({
  message,
  agent,
  providerLabel,
  canEdit,
  canRegenerate,
  onEdit,
  onRegenerate,
  notify,
}: {
  message: PublicMessage;
  agent: AgentView;
  providerLabel: string;
  canEdit: boolean;
  canRegenerate: boolean;
  onEdit: () => void;
  onRegenerate: () => void;
  notify: (value: string) => void;
}) {
  const user = message.role === "user";
  return (
    <article
      className={`message ${user ? "user-message" : "assistant-message"}`}
    >
      <span className={`message-avatar ${user ? "user-avatar" : agent.color}`}>
        {user ? "Y" : <AgentIcon icon={agent.icon} />}
      </span>
      <div className="message-content">
        <div className="message-heading">
          <strong>{user ? "You" : agent.name}</strong>
          {!user && <span>{providerLabel}</span>}
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>
        <div className="markdown">
          {message.text ? (
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                img: () => (
                  <span className="blocked-image">[Remote image hidden]</span>
                ),
                a: ({ href, children }) =>
                  /^https?:\/\//.test(href ?? "") ? (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  ) : (
                    <span>{children}</span>
                  ),
              }}
            >
              {message.text}
            </Markdown>
          ) : message.status === "streaming" ? (
            <span className="thinking-dots">
              <i />
              <i />
              <i />
              <span className="sr-only">Thinking</span>
            </span>
          ) : (
            <p className="muted">No text returned.</p>
          )}
        </div>
        <div className="message-actions">
          {message.text && (
            <button
              aria-label="Copy message"
              title="Copy message"
              onClick={() =>
                void navigator.clipboard
                  .writeText(message.text)
                  .then(() => notify("Copied to clipboard."))
                  .catch(() =>
                    notify(
                      "Clipboard unavailable. Select the text to copy it.",
                    ),
                  )
              }
            >
              <Copy size={13} />
            </button>
          )}
          {user && canEdit && (
            <button
              onClick={onEdit}
              aria-label="Edit message"
              title="Edit and resend"
            >
              <Pencil size={13} />
            </button>
          )}
          {!user && canRegenerate && (
            <button
              onClick={onRegenerate}
              aria-label="Regenerate response"
              title="Regenerate response"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {["stopped", "interrupted", "error"].includes(message.status) && (
            <span className="partial-label">
              {message.status === "error"
                ? "Response failed"
                : "Stopped · partial response"}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
