-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "context" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'cli',
    "model" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'repository',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "position" INTEGER NOT NULL DEFAULT 0,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "effort" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "reviewIterationCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "scheduledFor" DATETIME,
    "workspacePath" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" REAL,
    "branchName" TEXT,
    "commitSha" TEXT,
    "prSummary" TEXT,
    "cronExpression" TEXT,
    "maxRuns" INTEGER,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "pushToMain" BOOLEAN NOT NULL DEFAULT false,
    "targetBranch" TEXT,
    "createPR" BOOLEAN NOT NULL DEFAULT false,
    "prUrl" TEXT,
    "prNumber" INTEGER,
    "prUrls" TEXT,
    "prError" TEXT,
    "mergeableState" TEXT,
    "ciStatus" TEXT,
    "hasConflict" BOOLEAN NOT NULL DEFAULT false,
    "conflictMessage" TEXT,
    "noChanges" BOOLEAN NOT NULL DEFAULT false,
    "tokenBudget" INTEGER,
    "costBudget" REAL,
    "attachments" TEXT,
    "attachmentsFolder" TEXT,
    "contextFiles" TEXT,
    "notes" TEXT,
    "labels" TEXT,
    "sourceEmail" TEXT,
    "testPlan" TEXT,
    "reviewStatus" TEXT,
    "systemPrompt" TEXT,
    "isRecurringTemplate" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isHailMary" BOOLEAN NOT NULL DEFAULT false,
    "createValidationTask" BOOLEAN NOT NULL DEFAULT false,
    "useSmartProvider" BOOLEAN NOT NULL DEFAULT false,
    "lastScheduledAt" DATETIME,
    "recurringTemplateId" TEXT,
    "hailMaryEligible" BOOLEAN NOT NULL DEFAULT false,
    "hailMaryBurstLimit" INTEGER,
    "aiProviderId" TEXT,
    "dependsOnTaskId" TEXT,
    "teamId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_recurringTemplateId_fkey" FOREIGN KEY ("recurringTemplateId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_aiProviderId_fkey" FOREIGN KEY ("aiProviderId") REFERENCES "AIProvider" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("aiProviderId", "attachments", "attachmentsFolder", "branchName", "ciStatus", "commitSha", "conflictMessage", "context", "contextFiles", "costBudget", "createPR", "createValidationTask", "createdAt", "cronExpression", "dependsOnTaskId", "description", "effort", "estimatedCost", "hailMaryBurstLimit", "hailMaryEligible", "hasConflict", "id", "inputTokens", "isEnabled", "isHailMary", "isRecurringTemplate", "labels", "lastScheduledAt", "maxRuns", "mergeableState", "model", "nextRetryAt", "noChanges", "notes", "outputTokens", "outputType", "position", "prError", "prNumber", "prSummary", "prUrl", "prUrls", "priority", "provider", "pushToMain", "recurringTemplateId", "retryCount", "reviewIterationCount", "reviewStatus", "runCount", "scheduledFor", "sourceEmail", "status", "systemPrompt", "targetBranch", "testPlan", "title", "tokenBudget", "updatedAt", "useSmartProvider", "workspacePath") SELECT "aiProviderId", "attachments", "attachmentsFolder", "branchName", "ciStatus", "commitSha", "conflictMessage", "context", "contextFiles", "costBudget", "createPR", "createValidationTask", "createdAt", "cronExpression", "dependsOnTaskId", "description", "effort", "estimatedCost", "hailMaryBurstLimit", "hailMaryEligible", "hasConflict", "id", "inputTokens", "isEnabled", "isHailMary", "isRecurringTemplate", "labels", "lastScheduledAt", "maxRuns", "mergeableState", "model", "nextRetryAt", "noChanges", "notes", "outputTokens", "outputType", "position", "prError", "prNumber", "prSummary", "prUrl", "prUrls", "priority", "provider", "pushToMain", "recurringTemplateId", "retryCount", "reviewIterationCount", "reviewStatus", "runCount", "scheduledFor", "sourceEmail", "status", "systemPrompt", "targetBranch", "testPlan", "title", "tokenBudget", "updatedAt", "useSmartProvider", "workspacePath" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TeamMember_teamId_idx" ON "TeamMember"("teamId");

