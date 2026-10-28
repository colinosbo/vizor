import "./providers.mjs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  [join(root, "node_modules/next/dist/bin/next"), "build"],
  {
    cwd: root,
    env: {
      ...process.env,
      VIZOR_PORTABLE_BUILD: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
