import type { LiveEvent } from "../types";
import { AppError } from "./errors";
type Listener = (event: LiveEvent) => void;
const state = globalThis as unknown as {
  vizorListeners?: Map<string, Set<Listener>>;
};
const listeners = (state.vizorListeners ??= new Map());
export function publish(userId: string, event: LiveEvent = { type: "change" }) {
  for (const listener of listeners.get(userId) ?? []) listener(event);
}
export function subscribe(userId: string, listener: Listener) {
  const set = listeners.get(userId) ?? new Set();
  if (set.size >= 8)
    throw new AppError(
      "connections",
      "Too many live workspace connections. Close another Vizor tab and retry.",
      429,
    );
  set.add(listener);
  listeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(userId);
  };
}
export function eventStream(
  userId: string,
  validate: () => Promise<boolean>,
  signal: AbortSignal,
) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let queued = 0;
      let chain = Promise.resolve();
      const finish = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* Already disconnected. */
        }
      };
      const send = (event: LiveEvent) => {
        if (closed) return;
        if (++queued > 100) {
          finish();
          return;
        }
        chain = chain
          .then(async () => {
            queued--;
            if (closed) return;
            if (!(await validate())) {
              try {
                controller.enqueue(
                  encoder.encode('data: {"type":"unauthorized"}\n\n'),
                );
              } finally {
                finish();
              }
              return;
            }
            if ((controller.desiredSize ?? 1) <= 0) {
              finish();
              return;
            }
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          })
          .catch(finish);
      };
      const unsubscribe = subscribe(userId, send);
      const heartbeat = setInterval(() => send({ type: "change" }), 20000);
      cleanup = () => {
        unsubscribe();
        clearInterval(heartbeat);
        signal.removeEventListener("abort", finish);
      };
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
      else send({ type: "change" });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
