-- AlterTable: Add contextFiles column to Task
-- Stores a JSON-encoded array of { repoAlias: string; path: string } entries.
-- When the task runs, the file contents are read from the corresponding cloned
-- repo and injected into the prompt as read-only reference material.
-- NULL means no context files were selected.
ALTER TABLE "Task" ADD COLUMN "contextFiles" TEXT;
