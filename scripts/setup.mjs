import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import "dotenv/config";
mkdirSync("data", { recursive: true });
if (!existsSync(".env")) {
  writeFileSync(
    ".env",
    `DATABASE_URL="file:./data/vizor.db"\nSELF_HOST="true"\nAPP_ORIGIN="http://127.0.0.1:3000"\nMASTER_KEY="${randomBytes(32).toString("base64")}"\nNEXT_TELEMETRY_DISABLED="1"\nCHECKPOINT_DISABLE="1"\n`,
    { mode: 0o600 },
  );
  console.log(
    "Created .env with a permanent encryption key. Keep it with your backups.",
  );
}
const cli = "node_modules/prisma/build/index.js";
// The Windows schema engine requires an existing SQLite file on first deploy.
const databasePath = (process.env.DATABASE_URL ?? "file:./data/vizor.db").slice(
  5,
);
const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.close();
execFileSync(process.execPath, [cli, "generate"], {
  stdio: "inherit",
  env: { ...process.env, CHECKPOINT_DISABLE: "1" },
});
execFileSync(process.execPath, [cli, "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, CHECKPOINT_DISABLE: "1" },
});
console.log("Ready. Run npm run dev, then open http://127.0.0.1:3000.");
