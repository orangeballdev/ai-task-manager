-- AlterTable
ALTER TABLE "Task" ADD COLUMN "hasConflict" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "conflictMessage" TEXT;
