import { expect, it } from "vitest";
import {
  parseWritePaths,
  scopesConflict,
  writePathsSchema,
} from "../src/lib/server/work-scopes";

it("allows only disjoint declared paths in a shared Windows project", () => {
  const root = "C:\\work\\repo";
  expect(scopesConflict(root, ["src/a"], root, ["src/b"])).toBe(false);
  expect(scopesConflict(root, ["src/a"], root, ["src/a/file.ts"])).toBe(true);
  expect(scopesConflict(root, [], root, ["src/b"])).toBe(true);
  expect(scopesConflict(root, ["src/a"], "C:\\work\\other", ["src/a"])).toBe(
    false,
  );
  expect(scopesConflict(root, ["src"], "C:\\work\\repo\\src", ["a.ts"])).toBe(
    true,
  );
  for (const unsafe of [
    "../private",
    "/absolute",
    "C:\\outside",
    ".git/config",
    "src/*.ts",
  ])
    expect(writePathsSchema.safeParse([unsafe]).success).toBe(false);
  expect(parseWritePaths("invalid JSON")).toEqual([]);
});
