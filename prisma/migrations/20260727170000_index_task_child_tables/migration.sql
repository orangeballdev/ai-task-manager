-- Index taskId FKs so cascade deletes (e.g. bulk "Clear Done" on the Kanban
-- board) don't full-table-scan TaskLog/TaskMessage/TaskRepo, which grow
-- unboundedly as tasks stream output.
CREATE INDEX "TaskLog_taskId_idx" ON "TaskLog"("taskId");
CREATE INDEX "TaskMessage_taskId_idx" ON "TaskMessage"("taskId");
CREATE INDEX "TaskRepo_taskId_idx" ON "TaskRepo"("taskId");
