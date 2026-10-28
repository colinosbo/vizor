import { expect, it, afterAll } from "vitest";
import { GET } from "../src/app/api/health/route";
import { db } from "../src/lib/server/db";
import { version } from "../package.json";
afterAll(async () => {
  await db.$disconnect();
});
it("provides a minimal, uncached readiness marker without account or credential data", async () => {
  const response = await GET(
    new Request("http://127.0.0.1:3000/api/health", {
      headers: { host: "127.0.0.1:3000" },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    app: "vizor",
    status: "ok",
    version,
  });
});
it("retains the same host and cross-origin protection on readiness requests", async () => {
  for (const headers of [
    { host: "evil.invalid" },
    { host: "127.0.0.1:3000", origin: "https://evil.invalid" },
  ] as Record<string, string>[]) {
    const response = await GET(
      new Request("http://127.0.0.1:3000/api/health", { headers }),
    );
    expect(response.status).toBe(403);
  }
});
