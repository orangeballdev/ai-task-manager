-- RedefineTable: merge filesystem browser into the File model
-- Adds folder hierarchy (parentId/isFolder) and binary storage (blob/mimeType/size),
-- and makes content nullable (folders and binary files have no text content).
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "File_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "File_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_File" ("id", "taskId", "name", "content", "createdAt", "updatedAt")
SELECT "id", "taskId", "name", "content", "createdAt", "updatedAt" FROM "File";
DROP TABLE "File";
ALTER TABLE "new_File" RENAME TO "File";
CREATE INDEX "File_parentId_idx" ON "File"("parentId");
PRAGMA foreign_keys=ON;
