-- AlterTable: Add hailMaryEligible column to Task
ALTER TABLE "Task" ADD COLUMN "hailMaryEligible" BOOLEAN NOT NULL DEFAULT false;
