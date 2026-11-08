import { expect, it } from "vitest";
import {
  claudeUsage,
  codexUsage,
  usageRetry,
} from "../src/lib/server/runner-usage";

it("keeps both provider windows and uses the last blocking reset", () => {
  const now = 1_800_000_000_000;
  const shortReset = now / 1000 + 1200;
  const longReset = now / 1000 + 86400;
  const readings = claudeUsage({
    status: "rejected",
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { resetsAt: shortReset },
      seven_day: { utilization: 1, resetsAt: longReset },
    },
  });
  expect(readings).toEqual([
    {
      minutes: 300,
      usedPercent: 100,
      resetsAt: new Date(shortReset * 1000).toISOString(),
    },
    {
      minutes: 10080,
      usedPercent: 100,
      resetsAt: new Date(longReset * 1000).toISOString(),
    },
  ]);
  expect(usageRetry(readings, now).getTime()).toBe(longReset * 1000);
  expect(
    codexUsage({
      rateLimits: {
        primary: {
          usedPercent: 32,
          windowDurationMins: 300,
          resetsAt: shortReset,
        },
        secondary: null,
      },
    }),
  ).toEqual([
    {
      minutes: 300,
      usedPercent: 32,
      resetsAt: new Date(shortReset * 1000).toISOString(),
    },
  ]);
});

it("preserves unknown percentages and falls back when the blocking reset is unavailable", () => {
  const now = 1_800_000_000_000;
  const reset = now / 1000 + 1200;
  expect(claudeUsage({ rateLimitType: "five_hour", resetsAt: reset })).toEqual([
    { minutes: 300, resetsAt: new Date(reset * 1000).toISOString() },
  ]);
  expect(usageRetry([{ minutes: 300, usedPercent: 100 }], now).getTime()).toBe(
    now + 3 * 60 * 60 * 1000,
  );
  expect(codexUsage({})).toEqual([]);
});
