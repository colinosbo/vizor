import { z } from "zod";
export const checkNames = z.enum([
  "diff",
  "npm:test",
  "npm:typecheck",
  "npm:build",
]);
export const handoffSchema = z
  .strictObject({
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    branch: z
      .string()
      .regex(/^codex\/vizor-[a-zA-Z0-9-]+$/)
      .max(120),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    base: z
      .string()
      .regex(/^[\w][\w./-]*$/)
      .max(120),
    baseHead: z.string().regex(/^[a-f0-9]{40}$/),
    title: z.string().trim().min(1).max(160),
    description: z.string().max(800).default(""),
    files: z.array(z.string().min(1).max(240)).min(1).max(20),
    checks: z.array(z.string().max(500)).max(10),
    prUrl: z.url().max(300).optional(),
  })
  .refine((handoff) => {
    if (!handoff.prUrl) return true;
    const url = new URL(handoff.prUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      parts.length === 4 &&
      parts.slice(0, 2).join("/").toLowerCase() ===
        handoff.repository.toLowerCase() &&
      parts[2] === "pull" &&
      /^[1-9]\d*$/.test(parts[3])
    );
  }, "Use a PR link from the handoff repository.");
