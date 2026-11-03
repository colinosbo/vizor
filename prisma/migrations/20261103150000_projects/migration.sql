CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "workspaceLayout" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Project_userId_createdAt_idx" ON "Project"("userId", "createdAt");
ALTER TABLE "Agent" ADD COLUMN "projectId" TEXT REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Proposal" ADD COLUMN "projectId" TEXT;
CREATE INDEX "Proposal_userId_projectId_idx" ON "Proposal"("userId", "projectId");
ALTER TABLE "TerminalDispatch" ADD COLUMN "writePaths" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "TerminalDispatch" ADD COLUMN "outcome" TEXT;
CREATE TABLE "MergeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "expectedHead" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "repository" TEXT,
    "checksPassedAt" DATETIME,
    "checksHash" TEXT,
    "nextCheckAt" DATETIME,
    "claimedAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MergeJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MergeJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MergeJob_runId_toolCallId_key" ON "MergeJob"("runId", "toolCallId");
CREATE INDEX "MergeJob_userId_status_idx" ON "MergeJob"("userId", "status");
