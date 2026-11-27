-- AlterTable: Add notes and labels columns to Task
ALTER TABLE "Task" ADD COLUMN "notes" TEXT;
ALTER TABLE "Task" ADD COLUMN "labels" TEXT;
