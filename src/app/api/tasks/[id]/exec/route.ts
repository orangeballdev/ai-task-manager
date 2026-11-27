import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { prisma } from "@/lib/db";
import { getWorkspacePath } from "@/lib/workspace";
import fs from "fs";

const EXEC_TIMEOUT_MS = 30000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as { command: string; cwd?: string };
  const { command, cwd } = body;

  if (!command?.trim()) {
    return NextResponse.json({ error: "command is required" }, { status: 400 });
  }

  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspacePath = getWorkspacePath(id);
  if (!fs.existsSync(workspacePath)) {
    return NextResponse.json({ error: "Workspace does not exist for this task" }, { status: 400 });
  }

  // Validate the requested cwd is within the workspace
  let execCwd = workspacePath;
  if (cwd?.trim()) {
    const resolved = cwd.trim().startsWith("/") ? cwd.trim() : `${workspacePath}/${cwd.trim()}`;
    if (!resolved.startsWith(workspacePath)) {
      return NextResponse.json({ error: "cwd must be within the task workspace" }, { status: 400 });
    }
    execCwd = resolved;
  }

  return new Promise<NextResponse>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("bash", ["-c", command], {
      cwd: execCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, EXEC_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(NextResponse.json({
        stdout: stdout.slice(0, 50000),
        stderr: stderr.slice(0, 10000),
        exitCode: timedOut ? -1 : (code ?? -1),
        timedOut,
        cwd: execCwd,
      }));
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(NextResponse.json({ error: err.message }, { status: 500 }));
    });
  });
}
