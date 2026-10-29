CREATE TABLE "TerminalDispatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "error" TEXT,
    "claimedAt" DATETIME,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TerminalDispatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TerminalDispatch_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TerminalDispatch_proposalId_key" ON "TerminalDispatch"("proposalId");
CREATE INDEX "TerminalDispatch_userId_status_createdAt_idx" ON "TerminalDispatch"("userId", "status", "createdAt");
CREATE INDEX "TerminalDispatch_agentId_status_idx" ON "TerminalDispatch"("agentId", "status");
