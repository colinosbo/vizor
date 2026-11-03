ALTER TABLE "Agent" ADD COLUMN "terminalAuthMode" TEXT NOT NULL DEFAULT 'subscription';
ALTER TABLE "Agent" ADD COLUMN "orchestratorMode" TEXT NOT NULL DEFAULT 'api';
