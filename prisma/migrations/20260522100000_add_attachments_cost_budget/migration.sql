-- Add costBudget (float, USD) and attachments (JSON string) to Task
ALTER TABLE "Task" ADD COLUMN "costBudget" REAL;
ALTER TABLE "Task" ADD COLUMN "attachments" TEXT;
