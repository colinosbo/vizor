import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
const port = process.argv[2];
const db = new Database(process.env.DATABASE_URL.slice(5));
db.pragma("journal_mode = WAL");
db.close();
execFileSync(
  process.execPath,
  ["node_modules/prisma/build/index.js", "migrate", "deploy"],
  { stdio: "inherit", env: { ...process.env, CHECKPOINT_DISABLE: "1" } },
);
const child = spawn(
  process.execPath,
  [
    "--require",
    "./tests/fixtures/mock-anthropic.cjs",
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    port,
  ],
  { stdio: "inherit", env: process.env, windowsHide: true },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
child.on("exit", (code) => process.exit(code ?? 0));
