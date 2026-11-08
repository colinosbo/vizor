CREATE TABLE "SharedConnection" (
    "projectId" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "workerId" TEXT,
    "runnerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "SharedConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "TerminalDispatch" ADD COLUMN "sharedTaskId" TEXT;
ALTER TABLE "TerminalDispatch" ADD COLUMN "sharedTurnId" TEXT;
CREATE UNIQUE INDEX "TerminalDispatch_userId_sharedTurnId_key" ON "TerminalDispatch"("userId", "sharedTurnId");
