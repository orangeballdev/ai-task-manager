-- CreateIndex
CREATE INDEX "File_taskId_idx" ON "File"("taskId");

-- CreateIndex
CREATE INDEX "Task_recurringTemplateId_idx" ON "Task"("recurringTemplateId");

-- CreateIndex
CREATE INDEX "Task_dependsOnTaskId_idx" ON "Task"("dependsOnTaskId");
