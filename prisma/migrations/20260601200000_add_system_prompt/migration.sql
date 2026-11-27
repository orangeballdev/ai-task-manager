-- AlterTable: Add systemPrompt column to Task for per-task AI instruction override
ALTER TABLE "Task" ADD COLUMN "systemPrompt" TEXT;
