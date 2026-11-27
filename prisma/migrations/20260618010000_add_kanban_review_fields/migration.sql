-- AlterTable: Add testPlan and reviewStatus columns to Task for the kanban review workflow
ALTER TABLE "Task" ADD COLUMN "testPlan" TEXT;
ALTER TABLE "Task" ADD COLUMN "reviewStatus" TEXT;
