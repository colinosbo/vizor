"use client";
import { useEffect, useState } from "react";
import type { TerminalBridge } from "@/lib/terminal-types";
type UpdateState = {
  state: string;
  currentVersion: string;
  automatic: boolean;
  version?: string;
  progress?: number;
  message?: string;
};
declare global {
  interface Window {
    vizorDesktop?: {
      startupReady?(): Promise<void>;
      terminals?: TerminalBridge;
      getUpdateState(): Promise<UpdateState>;
      checkForUpdates(): Promise<UpdateState>;
      setAutomaticUpdates(enabled: boolean): Promise<UpdateState>;
      restartToUpdate(): Promise<{ ok: boolean; reason?: string }>;
      onUpdateState(callback: (state: UpdateState) => void): () => void;
    };
  }
}
export function DesktopUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const desktop = window.vizorDesktop;
    if (!desktop) return;
    let alive = true;
    const receive = (next: UpdateState) => {
      if (alive) {
        setState(next);
        if (next.state === "ready") setHidden(false);
      }
    };
    void desktop
      .getUpdateState()
      .then(receive)
      .catch(() => {});
    const remove = desktop.onUpdateState(receive);
    return () => {
      alive = false;
      remove();
    };
  }, []);
  if (
    !state ||
    hidden ||
    ![
      "checking",
      "downloading",
      "ready",
      "installing",
      "available",
      "error",
    ].includes(state.state)
  )
    return null;
  const text =
    state.message ||
    (state.state === "checking"
      ? "Checking for Vizor updates…"
      : state.state === "downloading"
        ? `Downloading Vizor ${state.version}… ${state.progress || 0}%`
        : state.state === "ready"
          ? `Vizor ${state.version} is ready. ${state.automatic ? "It will install when you close the app." : "Restart when you're ready to install."}`
          : state.state === "installing"
            ? "Restarting Vizor to install the update…"
            : state.state === "available"
              ? `Vizor ${state.version} is available. Enable automatic updates to download it.`
              : "Updates couldn't be checked. You can keep using Vizor.");
  return (
    <div className="desktop-update-banner" role="status" aria-live="polite">
      <span>{text}</span>
      <div>
        {state.state === "ready" && (
          <button
            className="secondary"
            onClick={() =>
              void window.vizorDesktop?.restartToUpdate().catch(() => {})
            }
          >
            Restart now
          </button>
        )}
        {state.state === "available" && (
          <button
            className="secondary"
            onClick={() =>
              void window.vizorDesktop
                ?.setAutomaticUpdates(true)
                .catch(() => {})
            }
          >
            Enable updates
          </button>
        )}
        {state.state === "error" && (
          <button
            className="secondary"
            onClick={() =>
              void window.vizorDesktop?.checkForUpdates().catch(() => {})
            }
          >
            Try again
          </button>
        )}
        {state.state !== "installing" && (
          <button
            className="text-button"
            aria-label="Dismiss update message"
            onClick={() => setHidden(true)}
          >
            Later
          </button>
        )}
      </div>
    </div>
  );
}
