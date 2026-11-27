import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { detachFromTrace } from "@/lib/otel";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const encoder = new TextEncoder();
  let lastId: string | null = null;
  let closed = false;

  req.signal.addEventListener("abort", () => { closed = true; });

  const stream = new ReadableStream({
    // Detached from the request's trace: this polls every 500ms for as long as
    // the tab is open, and those queries would otherwise pile up under one span.
    start: (controller) => detachFromTrace(async () => {
      // Send existing logs first
      const existing = await prisma.taskLog.findMany({
        where: { taskId: id },
        orderBy: { createdAt: "asc" },
      });
      for (const log of existing) {
        const data = JSON.stringify({ id: log.id, content: log.content, level: log.level, member: log.member, createdAt: log.createdAt });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        lastId = log.id;
      }

      // Poll for new logs
      while (!closed) {
        await new Promise((r) => setTimeout(r, 500));
        if (closed) break;

        const newLogs = await prisma.taskLog.findMany({
          where: {
            taskId: id,
            ...(lastId ? { id: { gt: lastId } } : {}),
          },
          orderBy: { createdAt: "asc" },
        }).catch(() => []);

        for (const log of newLogs) {
          const data = JSON.stringify({ id: log.id, content: log.content, level: log.level, member: log.member, createdAt: log.createdAt });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          lastId = log.id;
        }

        // Check if task is done
        const task = await prisma.task.findUnique({ where: { id }, select: { status: true } }).catch(() => null);
        if (task && ["completed", "no_changes", "failed", "killed", "timedout"].includes(task.status)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, status: task.status })}\n\n`));
          break;
        }
      }

      controller.close();
    }),
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
