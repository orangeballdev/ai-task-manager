-- AlterTable: Add prError column to Task so failed PR creation is surfaced to the user
ALTER TABLE "Task" ADD COLUMN "prError" TEXT;
