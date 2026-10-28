-- AlterTable
ALTER TABLE "Run" ADD COLUMN "proposalId" TEXT;

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "agentId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'user_request',
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "resultRunId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Proposal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subjectId" TEXT,
    "proposalId" TEXT,
    "approvedBy" TEXT,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderBudget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "limitMicros" BIGINT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProviderBudget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BudgetMonth" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "reservedMicros" BIGINT NOT NULL DEFAULT 0,
    "unknownCalls" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "BudgetMonth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpendEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "referenceId" TEXT,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'reserved',
    "quotedMicros" BIGINT NOT NULL DEFAULT 0,
    "chargedMicros" BIGINT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "inputRate" REAL,
    "outputRate" REAL,
    "estimated" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" DATETIME,
    CONSTRAINT "SpendEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "model" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "temperature" REAL NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER NOT NULL DEFAULT 2048,
    "color" TEXT NOT NULL DEFAULT 'mint',
    "icon" TEXT NOT NULL DEFAULT 'spark',
    "demo" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'agent',
    "contextSummary" TEXT NOT NULL DEFAULT '',
    "summaryThroughPosition" INTEGER NOT NULL DEFAULT -1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Agent" ("archived", "color", "createdAt", "demo", "icon", "id", "maxTokens", "model", "name", "paused", "provider", "systemPrompt", "temperature", "userId") SELECT "archived", "color", "createdAt", "demo", "icon", "id", "maxTokens", "model", "name", "paused", "provider", "systemPrompt", "temperature", "userId" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");
CREATE TABLE "new_Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "origin" TEXT NOT NULL DEFAULT 'user',
    "proposalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Message" ("conversationId", "createdAt", "id", "position", "role", "status", "text") SELECT "conversationId", "createdAt", "id", "position", "role", "status", "text" FROM "Message";
DROP TABLE "Message";
ALTER TABLE "new_Message" RENAME TO "Message";
CREATE UNIQUE INDEX "Message_conversationId_position_key" ON "Message"("conversationId", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Proposal_userId_status_createdAt_idx" ON "Proposal"("userId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_runId_toolCallId_key" ON "Proposal"("runId", "toolCallId");

-- CreateIndex
CREATE INDEX "AuditEntry_userId_createdAt_idx" ON "AuditEntry"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderBudget_userId_provider_key" ON "ProviderBudget"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetMonth_userId_provider_period_key" ON "BudgetMonth"("userId", "provider", "period");

-- CreateIndex
CREATE INDEX "SpendEntry_userId_provider_period_idx" ON "SpendEntry"("userId", "provider", "period");

-- CreateIndex
CREATE UNIQUE INDEX "Run_proposalId_key" ON "Run"("proposalId");

-- Preserve earlier app usage in the new ledger. Unknown/partial usage stays unknown.
INSERT INTO "SpendEntry" ("id","userId","provider","model","source","referenceId","period","status","quotedMicros","chargedMicros","inputTokens","outputTokens","estimated","createdAt","settledAt")
SELECT 'legacy-' || "id", "userId", "provider", "model", 'legacy', "id",
  COALESCE(strftime('%Y-%m', CASE WHEN typeof("createdAt") = 'integer' THEN datetime("createdAt" / 1000, 'unixepoch') ELSE "createdAt" END), strftime('%Y-%m','now')),
  CASE WHEN "cost" IS NULL OR "usageComplete" = 0 THEN 'unknown' ELSE 'settled' END,
  CAST(COALESCE("cost",0) * 1000000 + 0.999999 AS INTEGER), CAST(COALESCE("cost",0) * 1000000 + 0.999999 AS INTEGER), "inputTokens", "outputTokens", CASE WHEN "usageComplete" = 1 THEN 0 ELSE 1 END, "createdAt", COALESCE("endedAt","createdAt")
FROM "Run";
INSERT INTO "BudgetMonth" ("id","userId","provider","period","spentMicros","reservedMicros","unknownCalls")
SELECT 'legacy-month-' || "userId" || '-' || "provider" || '-' || "period", "userId","provider","period", SUM(COALESCE("chargedMicros",0)), 0, SUM(CASE WHEN "status" = 'unknown' THEN 1 ELSE 0 END)
FROM "SpendEntry" GROUP BY "userId","provider","period";
