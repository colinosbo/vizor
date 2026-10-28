import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
const master = randomBytes(32).toString("base64");
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    browserName: "chromium",
  },
  projects: [
    {
      name: "local",
      testMatch: /(workspace|accessibility|restart)\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:3100" },
    },
    {
      name: "stage-two",
      testMatch: /stage-two\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:3103" },
    },
    {
      name: "accounts",
      testMatch: /accounts\.spec\.ts/,
      use: { baseURL: "http://127.0.0.1:3101" },
    },
  ],
  webServer: [3100, 3101, 3103].map((port) => ({
    command: `node scripts/test-server.mjs ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 90000,
    env: {
      MASTER_KEY: master,
      SELF_HOST: port === 3101 ? "false" : "true",
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: `file:./data/browser-${port}-${process.pid}.db`,
    },
  })),
});
