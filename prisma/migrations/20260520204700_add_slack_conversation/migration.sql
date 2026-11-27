-- CreateTable
CREATE TABLE "SlackConversation" (
    "threadTs" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "messages" TEXT NOT NULL,
    "proposed" TEXT,
    "taskId" TEXT,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
