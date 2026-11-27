-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Webhook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "secretToken" TEXT NOT NULL,
    "secretHeader" TEXT NOT NULL DEFAULT 'X-Webhook-Secret',
    "taskTitle" TEXT NOT NULL,
    "taskDescription" TEXT NOT NULL,
    "taskContext" TEXT,
    "repoUrl" TEXT,
    "repoAlias" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Webhook" ("createdAt", "id", "isEnabled", "name", "repoAlias", "repoUrl", "secretToken", "slug", "taskContext", "taskDescription", "taskTitle", "updatedAt") SELECT "createdAt", "id", "isEnabled", "name", "repoAlias", "repoUrl", "secretToken", "slug", "taskContext", "taskDescription", "taskTitle", "updatedAt" FROM "Webhook";
DROP TABLE "Webhook";
ALTER TABLE "new_Webhook" RENAME TO "Webhook";
CREATE UNIQUE INDEX "Webhook_slug_key" ON "Webhook"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
