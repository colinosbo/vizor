import { z } from "zod";

export type UsageWindow = {
  minutes: number;
  usedPercent?: number;
  resetsAt?: string;
};

const timestamp = z.number().int().positive().max(253402300799);
const percent = z.number().min(0);
function window(minutes: number, used: unknown, reset: unknown): UsageWindow {
  const usedPercent = percent.safeParse(used).data;
  const epoch = timestamp.safeParse(reset).data;
  return {
    minutes,
    ...(usedPercent === undefined
      ? {}
      : { usedPercent: Math.min(100, usedPercent) }),
    ...(epoch === undefined
      ? {}
      : { resetsAt: new Date(epoch * 1000).toISOString() }),
  };
}

const claudeWindow = z.object({
  utilization: z.number().optional(),
  resetsAt: timestamp.optional(),
});
const claudeLimit = claudeWindow.extend({
  rateLimitType: z.string().optional(),
  status: z.string().optional(),
  unifiedWindows: z.record(z.string(), claudeWindow).optional(),
});
const claudeMinutes = { five_hour: 300, seven_day: 10080 };
export function claudeUsage(info: unknown): UsageWindow[] {
  const parsed = claudeLimit.safeParse(info);
  if (!parsed.success) return [];
  const data = parsed.data;
  return Object.entries(claudeMinutes).flatMap(([name, minutes]) => {
    const reading =
      data.unifiedWindows?.[name] ??
      (data.rateLimitType === name ? data : undefined);
    return reading
      ? [
          window(
            minutes,
            data.status === "rejected" && data.rateLimitType === name
              ? 100
              : reading.utilization === undefined
                ? undefined
                : reading.utilization * 100,
            reading.resetsAt,
          ),
        ]
      : [];
  });
}

const codexWindow = z.object({
  usedPercent: percent,
  windowDurationMins: z.number().int().positive().max(43200),
  resetsAt: timestamp.nullish(),
});
const codexLimits = z.object({
  rateLimits: z.object({
    primary: codexWindow.nullish(),
    secondary: codexWindow.nullish(),
  }),
});
export function codexUsage(result: unknown): UsageWindow[] {
  const parsed = codexLimits.safeParse(result);
  if (!parsed.success) return [];
  const { primary, secondary } = parsed.data.rateLimits;
  return [primary, secondary].flatMap((reading) =>
    reading
      ? [
          window(
            reading.windowDurationMins,
            reading.usedPercent,
            reading.resetsAt,
          ),
        ]
      : [],
  );
}

export function usageRetry(windows: UsageWindow[], now = Date.now()) {
  const resets = windows
    .filter((reading) => reading.usedPercent === 100)
    .map((reading) => Date.parse(reading.resetsAt ?? ""))
    .filter((reset) => reset > now && reset <= now + 8 * 24 * 60 * 60 * 1000);
  return new Date(
    resets.length ? Math.max(...resets) : now + 3 * 60 * 60 * 1000,
  );
}
