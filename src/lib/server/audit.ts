import { db } from "./db";
import type { Prisma } from "@/generated/prisma/client";
export type AuditActor = {
  actor?: "user" | "orchestrator" | "system";
  proposalId?: string;
  approvedBy?: string;
};
export async function audit(
  userId: string,
  action: string,
  subjectId: string | null = null,
  details: Record<string, unknown> = {},
  actor: AuditActor = {},
  tx: Prisma.TransactionClient = db,
) {
  return tx.auditEntry.create({
    data: {
      userId,
      action,
      subjectId,
      actor: actor.actor ?? "user",
      proposalId: actor.proposalId,
      approvedBy: actor.approvedBy,
      details: JSON.stringify(details),
    },
  });
}
