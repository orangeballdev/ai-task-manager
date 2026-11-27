-- AlterTable
ALTER TABLE "Task" ADD COLUMN "hailMaryBurstLimit" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "isFolder" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT,
    "blob" BLOB,
    "mimeType" TEXT,
    "size" INTEGER,
    "protected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "File_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "File_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_File" ("blob", "content", "createdAt", "id", "isFolder", "mimeType", "name", "parentId", "size", "taskId", "updatedAt") SELECT "blob", "content", "createdAt", "id", "isFolder", "mimeType", "name", "parentId", "size", "taskId", "updatedAt" FROM "File";
DROP TABLE "File";
ALTER TABLE "new_File" RENAME TO "File";
CREATE INDEX "File_parentId_idx" ON "File"("parentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
