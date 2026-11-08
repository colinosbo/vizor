ALTER TABLE "Project" ADD COLUMN "reviewEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "PullRequestReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "repository" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "head" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "findings" TEXT NOT NULL DEFAULT '[]',
    "handedOff" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PullRequestReview_projectId_repository_number_head_key" ON "PullRequestReview"("projectId", "repository", "number", "head");
CREATE INDEX "PullRequestReview_projectId_status_updatedAt_idx" ON "PullRequestReview"("projectId", "status", "updatedAt");
