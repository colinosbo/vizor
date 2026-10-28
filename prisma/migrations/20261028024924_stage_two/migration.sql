-- CreateTable
CREATE TABLE "AgentTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Agent" ("color", "createdAt", "demo", "icon", "id", "maxTokens", "model", "name", "provider", "systemPrompt", "temperature", "userId") SELECT "color", "createdAt", "demo", "icon", "id", "maxTokens", "model", "name", "provider", "systemPrompt", "temperature", "userId" FROM "Agent";
DROP TABLE "Agent";
ALTER TABLE "new_Agent" RENAME TO "Agent";
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "assistantId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "status" TEXT NOT NULL DEFAULT 'running',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cost" REAL,
    "usageComplete" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "Run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("assistantId", "clientId", "conversationId", "cost", "createdAt", "endedAt", "errorCode", "id", "inputTokens", "model", "outputTokens", "status", "usageComplete", "userId") SELECT "assistantId", "clientId", "conversationId", "cost", "createdAt", "endedAt", "errorCode", "id", "inputTokens", "model", "outputTokens", "status", "usageComplete", "userId" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_userId_conversationId_idx" ON "Run"("userId", "conversationId");
CREATE UNIQUE INDEX "Run_userId_clientId_key" ON "Run"("userId", "clientId");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceLayout" TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO "new_User" ("createdAt", "email", "id", "passwordHash") SELECT "createdAt", "email", "id", "passwordHash" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AgentTemplate_userId_idx" ON "AgentTemplate"("userId");
