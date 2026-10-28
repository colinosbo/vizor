import { mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { checkNode, ensureConfig, databasePath } from "./local-runtime.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  checkNode();
  process.chdir(root);
  const { config, created } = ensureConfig(root);
  if (created)
    console.log(
      "Created .env with a permanent encryption key. Keep it with your backups.",
    );
  const path = databasePath(root, config.DATABASE_URL);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  database.pragma("journal_mode = WAL");
  database.close();
  if (process.platform !== "win32") chmodSync(path, 0o600);
  const cli = "node_modules/prisma/build/index.js";
  for (const args of [["generate"], ["migrate", "deploy"]])
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      stdio: "inherit",
      env: config,
    });
  console.log(
    "Workspace ready. Use the Start Vizor launcher or npm run launch to open the app.",
  );
} catch (error) {
  console.error(`Setup could not finish: ${error.message}`);
  process.exitCode = 1;
}
