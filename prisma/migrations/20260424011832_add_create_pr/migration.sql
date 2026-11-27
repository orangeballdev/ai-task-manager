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
    "status" TEXT NOT NULL DEFAULT 'pending',
    "position" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "scheduledFor" DATETIME,
    "workspacePath" TEXT,
    "branchName" TEXT,
    "prSummary" TEXT,
    "cronExpression" TEXT,
    "pushToMain" BOOLEAN NOT NULL DEFAULT false,
    "createPR" BOOLEAN NOT NULL DEFAULT false,
    "prUrl" TEXT,
    "isRecurringTemplate" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastScheduledAt" DATETIME,
    "recurringTemplateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_recurringTemplateId_fkey" FOREIGN KEY ("recurringTemplateId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("branchName", "context", "createdAt", "cronExpression", "description", "id", "isEnabled", "isRecurringTemplate", "lastScheduledAt", "model", "nextRetryAt", "position", "prSummary", "provider", "pushToMain", "recurringTemplateId", "retryCount", "scheduledFor", "status", "title", "updatedAt", "workspacePath") SELECT "branchName", "context", "createdAt", "cronExpression", "description", "id", "isEnabled", "isRecurringTemplate", "lastScheduledAt", "model", "nextRetryAt", "position", "prSummary", "provider", "pushToMain", "recurringTemplateId", "retryCount", "scheduledFor", "status", "title", "updatedAt", "workspacePath" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
