-- AlterTable: Add prUrls column to Task — a JSON map of repo alias -> { url, number, merged }
-- so PR-merge sync can track every PR created for a multi-repo task instead of only the
-- last one (which caused multi-repo tasks to jump straight to Done as soon as any single
-- PR looked merged).
ALTER TABLE "Task" ADD COLUMN "prUrls" TEXT;
