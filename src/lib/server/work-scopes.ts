import { win32 } from "node:path";
import { z } from "zod";

export const writePathsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => {
        const path = value.replaceAll("\\", "/");
        return (
          !path.startsWith("/") &&
          !path.includes(":") &&
          !/[\0*?]/.test(path) &&
          path
            .split("/")
            .every(
              (part) =>
                part !== ".." &&
                part !== "." &&
                part !== "" &&
                part.toLowerCase() !== ".git",
            )
        );
      }, "Use project-relative file or folder paths without wildcards or '..'."),
  )
  .max(20);

export function scopesConflict(
  rootA: string,
  pathsA: string[],
  rootB: string,
  pathsB: string[],
) {
  const a = win32.resolve(rootA).toLowerCase();
  const b = win32.resolve(rootB).toLowerCase();
  const overlaps = (left: string, right: string) =>
    left === right ||
    left.startsWith(right + "\\") ||
    right.startsWith(left + "\\");
  if (!overlaps(a, b)) return false;
  if (!pathsA.length || !pathsB.length) return true;
  return pathsA.some((left) =>
    pathsB.some((right) =>
      overlaps(
        win32.resolve(a, left).toLowerCase(),
        win32.resolve(b, right).toLowerCase(),
      ),
    ),
  );
}

export function parseWritePaths(raw: string): string[] {
  try {
    return writePathsSchema.parse(JSON.parse(raw));
  } catch {
    return [];
  }
}
