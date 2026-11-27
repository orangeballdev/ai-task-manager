-- AlterTable: Add priority column to Task — manual priority ("low" | "normal" | "high" | "urgent")
-- set via Advanced Options at task creation/edit time. The worker sorts pending/paused/throttled
-- tasks by priority (desc) then position (asc) when picking up the next task to run.
ALTER TABLE "Task" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'normal';
