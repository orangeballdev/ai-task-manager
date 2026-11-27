-- AlterTable: Add outputType column to Task
ALTER TABLE "Task" ADD COLUMN "outputType" TEXT NOT NULL DEFAULT 'repository';

-- CreateTable: File model for storing markdown outputs
CREATE TABLE "File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "File_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
