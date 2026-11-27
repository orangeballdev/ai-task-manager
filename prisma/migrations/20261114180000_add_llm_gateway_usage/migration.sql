-- CreateTable
CREATE TABLE "LlmGatewayUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "apiKeyId" TEXT NOT NULL,
    "apiKeyName" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "providerId" TEXT,
    "providerName" TEXT,
    "providerType" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" REAL,
    "errorType" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LlmGatewayUsage_createdAt_idx" ON "LlmGatewayUsage"("createdAt");
