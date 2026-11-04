import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "../src/lib/server/db";
import { owner } from "../src/lib/server/security";
beforeAll(() => {
  const sqlite = new Database(process.env.DATABASE_URL!.slice(5));
  for (const name of readdirSync("prisma/migrations")
    .filter((n) => /^\d/.test(n))
    .sort())
    sqlite.exec(
      readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"),
    );
  sqlite.close();
});
afterAll(async () => {
  await db.$disconnect();
});
it("starts a new local account in full auto mode", async () => {
  process.env.SELF_HOST = "true";
  const user = await owner(new Request("http://127.0.0.1:3000/api/workspace"));
  const settings = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { autoApprove: true, queueEnabled: true },
  });
  expect(settings).toEqual({ autoApprove: true, queueEnabled: true });
});
