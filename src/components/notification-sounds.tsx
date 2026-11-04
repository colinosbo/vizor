"use client";
import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { Workspace } from "@/lib/types";

const MUTE_KEY = "vizor.notifications.muted";
export function NotificationSounds({ data }: { data: Workspace | null }) {
  const [muted, setMuted] = useState(false);
  const previous = useRef<{
    messages: Map<string, string>;
    proposals: Set<string>;
  } | null>(null);
  const audio = useRef<AudioContext | null>(null);
  useEffect(() => {
    try {
      setMuted(localStorage.getItem(MUTE_KEY) === "true");
    } catch {}
    return () => {
      void audio.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!data) {
      previous.current = null;
      return;
    }
    const messages = new Map<string, string>();
    if (data.notificationState) {
      for (const message of data.notificationState.messages)
        messages.set(message.id, message.status);
    } else
      for (const agent of [
        ...data.agents,
        ...(data.orchestrator ? [data.orchestrator] : []),
      ])
        for (const message of agent.conversation.messages)
          if (message.role === "assistant")
            messages.set(message.id, message.status);
    const proposals = new Set(
      data.notificationState?.pendingProposals ??
        data.proposals.filter((p) => p.status === "pending").map((p) => p.id),
    );
    const old = previous.current;
    previous.current = { messages, proposals };
    if (!old || muted) return;
    const approval = [...proposals].some((id) => !old.proposals.has(id));
    const complete = [...messages].some(
      ([id, status]) =>
        status === "complete" && old.messages.get(id) !== "complete",
    );
    if (!approval && !complete) return;
    try {
      const context = (audio.current ??= new AudioContext());
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = approval ? 740 : 520;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.18,
      );
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
      if (context.state === "suspended") void context.resume().catch(() => {});
    } catch {
      /* Audio is optional when the system disallows playback. */
    }
  }, [data, muted]);
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={muted ? "Unmute notifications" : "Mute notifications"}
      title={muted ? "Unmute notifications" : "Mute notifications"}
      onClick={() => {
        const next = !muted;
        setMuted(next);
        try {
          localStorage.setItem(MUTE_KEY, String(next));
        } catch {}
      }}
    >
      {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </button>
  );
}
