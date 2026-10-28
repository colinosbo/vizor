import { expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  workspacePaths,
  localNavigation,
  externalLink,
} = require("../desktop/policy.cjs");
it("keeps installed data outside program files and supports an explicit isolated local directory", () => {
  const home =
    process.platform === "win32"
      ? "C:\\Users\\Example\\AppData\\Local"
      : "/home/example/.local/share";
  const paths = workspacePaths(home);
  expect(paths.workspace).toContain("Vizor");
  expect(paths.workspace).toMatch(/workspace$/);
  expect(paths.shell).toMatch(/shell$/);
  expect(() => workspacePaths("relative-folder")).toThrow("absolute");
  expect(() => workspacePaths(home, "relative-folder")).toThrow("absolute");
});
it("limits the app window to its exact local origin", () => {
  const origin = "http://127.0.0.1:54321";
  expect(localNavigation(`${origin}/api/workspace`, origin)).toBe(true);
  for (const url of [
    "http://127.0.0.1:54322/",
    "http://localhost:54321/",
    "https://example.com",
    "file:///C:/secret",
    "javascript:alert(1)",
    "data:text/html,test",
  ])
    expect(localNavigation(url, origin)).toBe(false);
});
it("opens only ordinary HTTPS links in the system browser", () => {
  expect(externalLink("https://platform.openai.com/api-keys")).toBe(
    "https://platform.openai.com/api-keys",
  );
  for (const url of [
    "file:///C:/Windows/System32/cmd.exe",
    "javascript:alert(1)",
    "ms-settings:privacy",
    "https://user:password@example.com",
    "http://example.com",
    "garbage",
  ])
    expect(externalLink(url)).toBeNull();
});
