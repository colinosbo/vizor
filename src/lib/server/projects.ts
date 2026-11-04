import { z } from "zod";
import { db } from "./db";
import { publish } from "./events";
import { AppError } from "./errors";

export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(70),
    folder: z
      .string()
      .min(3)
      .max(4096)
      .refine(
        (value) => /^[a-zA-Z]:[\\/]/.test(value) && !value.includes("\0"),
        "Choose a local project folder.",
      ),
  })
  .strict();

export async function createProject(
  userId: string,
  input: z.infer<typeof projectInput>,
) {
  const project = await db.project.create({
    data: { userId, ...projectInput.parse(input) },
    select: { id: true, name: true, folder: true, createdAt: true },
  });
  publish(userId);
  return project;
}

export async function ownedProject(userId: string, id: string) {
  const project = await db.project.findFirst({ where: { id, userId } });
  if (!project)
    throw new AppError("not_found", "This project was not found.", 404);
  return project;
}

export function requireCodingWorker(name: string, role: string) {
  if (
    /\b(?:review|reviewer|review agent|code reviewer|auditor)\s*$/i.test(
      name.trim(),
    ) ||
    /^\s*(?:you are\s+(?:an?\s+)?)?(?:a\s+)?(?:code\s+)?(?:reviewer|auditor|review-only)\b/i.test(
      role,
    )
  )
    throw new AppError(
      "coding_workers_only",
      "Projects use coding workers, not review-only agents.",
      400,
    );
}

export function requireProjectFolder(expected: string, actual: string) {
  const normalize = (value: string) =>
    value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  if (normalize(expected) !== normalize(actual))
    throw new AppError(
      "project_folder",
      "Workers must use the selected project folder.",
      400,
    );
}
