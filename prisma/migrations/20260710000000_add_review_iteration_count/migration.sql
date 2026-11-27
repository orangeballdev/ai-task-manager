-- AlterTable: Add reviewIterationCount column to Task — tracks "Review PR" self-review
-- re-runs separately from retryCount, since a review iteration (no changes needed, or
-- changes made) is expected workflow, not a failure/retry.
ALTER TABLE "Task" ADD COLUMN "reviewIterationCount" INTEGER NOT NULL DEFAULT 0;
