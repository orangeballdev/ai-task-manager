-- AlterTable: Add PR mergeability/CI status fields surfaced on the Kanban card
ALTER TABLE "Task" ADD COLUMN "prNumber" INTEGER;
ALTER TABLE "Task" ADD COLUMN "mergeableState" TEXT;
ALTER TABLE "Task" ADD COLUMN "ciStatus" TEXT;
