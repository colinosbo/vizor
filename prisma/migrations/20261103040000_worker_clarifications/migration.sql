ALTER TABLE "Agent" ADD COLUMN "permissionMode" TEXT NOT NULL DEFAULT 'acceptEdits';
ALTER TABLE "TerminalDispatch" ADD COLUMN "questions" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "TerminalDispatch" ADD COLUMN "autoDeliver" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TerminalDispatch" ADD COLUMN "replyToId" TEXT;
ALTER TABLE "TerminalDispatch" ADD COLUMN "replyDepth" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "TerminalDispatch_replyToId_key" ON "TerminalDispatch"("replyToId");
UPDATE "User" SET "workspaceLayout" = json_set(
  CASE WHEN json_valid("workspaceLayout") THEN "workspaceLayout" ELSE '{}' END,
  '$.mode', 'live', '$.textSize', 'comfortable'
);
