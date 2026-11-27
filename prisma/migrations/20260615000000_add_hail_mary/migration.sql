-- AlterTable: Add isHailMary column to Task for marking recurring templates as Hail Mary tasks
ALTER TABLE "Task" ADD COLUMN "isHailMary" BOOLEAN NOT NULL DEFAULT false;
