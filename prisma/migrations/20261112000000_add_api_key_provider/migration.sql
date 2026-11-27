-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "aiProviderId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "useSmartProvider" BOOLEAN NOT NULL DEFAULT false;
