-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "secretHash" TEXT,
    "clientUri" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "OAuthAuthCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',
    "resource" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_McpToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'read',
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "oauthClientId" TEXT,
    "refreshTokenHash" TEXT,
    "refreshExpiresAt" DATETIME,
    CONSTRAINT "McpToken_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_McpToken" ("access", "createdAt", "id", "keyHash", "keyPrefix", "lastUsedAt", "name") SELECT "access", "createdAt", "id", "keyHash", "keyPrefix", "lastUsedAt", "name" FROM "McpToken";
DROP TABLE "McpToken";
ALTER TABLE "new_McpToken" RENAME TO "McpToken";
CREATE UNIQUE INDEX "McpToken_keyHash_key" ON "McpToken"("keyHash");
CREATE UNIQUE INDEX "McpToken_refreshTokenHash_key" ON "McpToken"("refreshTokenHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAuthCode_codeHash_key" ON "OAuthAuthCode"("codeHash");

