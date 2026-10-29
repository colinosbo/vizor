"use client";

import { useEffect, useRef, useState } from "react";

export function StartupIntro({
  ready,
  onComplete,
}: {
  ready: boolean;
  onComplete(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(true);
  const [native, setNative] = useState<boolean | null>(null);
  useEffect(() => {
    if (!visible) onComplete();
  }, [visible, onComplete]);
  useEffect(() => {
    setNative(!!window.vizorDesktop?.startupReady);
  }, []);
  useEffect(() => {
    if (!ready) return;
    if (window.vizorDesktop?.startupReady) {
      void window.vizorDesktop
        .startupReady()
        .finally(() => setVisible(false))
        .catch(() => {});
    } else {
      frame.current?.contentWindow?.postMessage(
        { type: "vizor:workspace-ready" },
        window.location.origin,
      );
    }
    const timeout = window.setTimeout(() => setVisible(false), 8000);
    return () => window.clearTimeout(timeout);
  }, [ready]);
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== window.location.origin
      )
        return;
      if (event.data?.type === "vizor:intro-complete") setVisible(false);
      if (event.data?.type === "vizor:intro-reveal") {
        document.documentElement.classList.add("startup-revealing");
      }
      if (ready && event.data?.type === "vizor:intro-mounted") {
        frame.current?.contentWindow?.postMessage(
          { type: "vizor:workspace-ready" },
          window.location.origin,
        );
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [ready]);
  // The native shell owns the same animation during backend startup.
  if (!visible || native) return null;
  if (native === null)
    return (
      <div
        className="startup-intro startup-placeholder"
        role="status"
        aria-label="Opening Vizor"
      />
    );
  return (
    <iframe
      ref={frame}
      className="startup-intro"
      src="/intro/index.html"
      title="Opening Vizor"
      onLoad={() => {
        frame.current?.focus();
        if (ready)
          frame.current?.contentWindow?.postMessage(
            { type: "vizor:workspace-ready" },
            window.location.origin,
          );
      }}
      onError={() => setVisible(false)}
    />
  );
}
