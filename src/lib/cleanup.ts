import { cleanWorkspace } from "./workspace";
import { getAppHost, getNotificationSettings, sendFileDeletionNotification } from "./notifications";
import { TERMINAL_STATUSES, parseRetentionScope, selectTasksForCleanup } from "./task-retention";

const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_FILE_RETENTION_DAYS = 30;
// task_history entries record what an agent did on a past run and go stale
// quickly (the codebase moves on). design_spec entries represent intentional
// architectural decisions and are exempt from this TTL.
const DEFAULT_KNOWLEDGE_TTL_DAYS = 60;

export interface FileCleanupNode {
  id: string;
  parentId: string | null;
  protected: boolean;
  createdAt: Date;
}

// Which File rows are safe to delete for age-based cleanup, honoring the
// `protected` flag. This needs the whole tree (not a plain age filter)
// because of two things the DB schema does that a naive filter would miss:
//
//   1. Protecting a folder must protect everything nested inside it, so a
//      protected flag on an ancestor exempts a descendant even if the
//      descendant itself isn't marked protected.
//   2. File.parentId cascades ON DELETE — deleting an old, unprotected
//      folder would delete every descendant row regardless of the
//      descendant's own age or protected flag. So a folder can only be
//      deleted if nothing anywhere in its subtree is protected.
export function computeDeletableFileIds(files: FileCleanupNode[], cutoff: Date): string[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const childrenOf = new Map<string, FileCleanupNode[]>();
  for (const f of files) {
    if (f.parentId) {
      const list = childrenOf.get(f.parentId);
      if (list) list.push(f);
      else childrenOf.set(f.parentId, [f]);
    }
  }

  const ancestorProtectedCache = new Map<string, boolean>();
  function hasProtectedAncestor(id: string): boolean {
    const cached = ancestorProtectedCache.get(id);
    if (cached !== undefined) return cached;
    const parentId = byId.get(id)?.parentId ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    const result = !!parent && (parent.protected || hasProtectedAncestor(parent.id));
    ancestorProtectedCache.set(id, result);
    return result;
  }

  const subtreeProtectedCache = new Map<string, boolean>();
  function subtreeHasProtected(id: string): boolean {
    const cached = subtreeProtectedCache.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    let result = !!node?.protected;
    if (!result) {
      for (const child of childrenOf.get(id) ?? []) {
        if (subtreeHasProtected(child.id)) {
          result = true;
          break;
        }
      }
    }
    subtreeProtectedCache.set(id, result);
    return result;
  }

  return files
    .filter((f) => f.createdAt < cutoff && !hasProtectedAncestor(f.id) && !subtreeHasProtected(f.id))
    .map((f) => f.id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runCleanup(prisma: any): Promise<{ deleted: number }> {
  const [setting, scopeSetting, fileSetting, knowledgeTtlSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "task_retention_days" } }),
    prisma.setting.findUnique({ where: { key: "task_retention_scope" } }),
    prisma.setting.findUnique({ where: { key: "file_retention_days" } }),
    prisma.setting.findUnique({ where: { key: "knowledge_ttl_days" } }),
  ]);

  const retentionDays = setting?.value ? parseInt(setting.value, 10) : DEFAULT_RETENTION_DAYS;
  const retentionScope = parseRetentionScope(scopeSetting?.value);
  const fileRetentionDays = fileSetting?.value ? parseInt(fileSetting.value, 10) : DEFAULT_FILE_RETENTION_DAYS;
  const knowledgeTtlDays = knowledgeTtlSetting?.value ? parseInt(knowledgeTtlSetting.value, 10) : DEFAULT_KNOWLEDGE_TTL_DAYS;

  let deleted = 0;

  // Clean up old tasks
  if (!isNaN(retentionDays) && retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const tasks = await prisma.task.findMany({
      where: {
        isRecurringTemplate: false,
        status: { in: TERMINAL_STATUSES },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, status: true, reviewStatus: true, prUrl: true, prUrls: true },
    });

    const ids = selectTasksForCleanup(tasks, retentionScope);
    if (ids.length > 0) {
      await Promise.all(ids.map((id: string) => cleanWorkspace(id)));
      await prisma.task.deleteMany({ where: { id: { in: ids } } });
      deleted += ids.length;
    }
  }

  // Clean up old File records — skipping anything protected (see
  // computeDeletableFileIds for why this needs the whole tree, not just a
  // simple age filter).
  if (!isNaN(fileRetentionDays) && fileRetentionDays > 0) {
    const fileCutoff = new Date(Date.now() - fileRetentionDays * 24 * 60 * 60 * 1000);
    const allFiles = await prisma.file.findMany({
      select: { id: true, name: true, parentId: true, protected: true, createdAt: true },
    });
    const deletableIds = computeDeletableFileIds(allFiles, fileCutoff);
    if (deletableIds.length > 0) {
      // Notify (with filenames) before the files are actually removed, since
      // once deleted there's nothing left to reference for the email.
      try {
        const byId = new Map<string, { id: string; name: string; parentId: string | null }>(
          allFiles.map((f: { id: string; name: string; parentId: string | null }) => [f.id, f])
        );
        const buildPath = (id: string): string => {
          const node = byId.get(id);
          if (!node) return id;
          const parentPath = node.parentId ? buildPath(node.parentId) : "";
          return parentPath ? `${parentPath}/${node.name}` : node.name;
        };
        const fileNames = deletableIds.map((id: string) => buildPath(id));

        const [notif, appHost] = await Promise.all([getNotificationSettings(prisma), getAppHost(prisma)]);
        const notifResult = await sendFileDeletionNotification(notif, fileNames, fileRetentionDays, appHost);
        if (!notifResult.sent) {
          console.log(`Cleanup: file deletion notification not sent — ${notifResult.reason}`);
        }
      } catch (err) {
        console.error("Cleanup: failed to send file deletion notification", err);
      }

      const result = await prisma.file.deleteMany({ where: { id: { in: deletableIds } } });
      if (result.count > 0) {
        console.log(`Cleanup: removed ${result.count} old file record(s)`);
      }
    }
  }

  // Expire stale task_history knowledge entries. design_spec entries represent
  // intentional architectural decisions and are not subject to this TTL —
  // only entries recording what an agent did on some past run go stale.
  if (!isNaN(knowledgeTtlDays) && knowledgeTtlDays > 0) {
    const knowledgeCutoff = new Date(Date.now() - knowledgeTtlDays * 24 * 60 * 60 * 1000);
    const result = await prisma.knowledgeEntry.deleteMany({
      where: {
        type: "task_history",
        updatedAt: { lt: knowledgeCutoff },
      },
    });
    if (result.count > 0) {
      console.log(`Cleanup: removed ${result.count} stale knowledge entr${result.count === 1 ? "y" : "ies"}`);
    }
  }

  return { deleted };
}
