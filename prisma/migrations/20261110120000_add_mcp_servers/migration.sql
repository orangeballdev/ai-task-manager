-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'stdio',
    "command" TEXT,
    "args" TEXT NOT NULL DEFAULT '[]',
    "env" TEXT NOT NULL DEFAULT '{}',
    "url" TEXT,
    "headers" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_name_key" ON "McpServer"("name");
