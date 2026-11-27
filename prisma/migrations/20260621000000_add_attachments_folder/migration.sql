-- AlterTable: Add attachmentsFolder column to Task
-- Stores the target folder (relative to the workspace / repo root) where
-- uploaded attachment files should be placed when the agent runs.
-- NULL or empty means "place at the workspace root".
ALTER TABLE "Task" ADD COLUMN "attachmentsFolder" TEXT;
