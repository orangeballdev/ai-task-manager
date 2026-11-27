import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/db";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const execAsync = promisify(exec);

async function run(cmd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 5000 });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: msg };
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { step: string; baseUrl?: string; model?: string };
  const { step } = body;

  switch (step) {
    case "claude-cli": {
      const r = await run("claude --version");
      return NextResponse.json({ ok: r.ok, output: r.output });
    }

    case "claude-auth": {
      const r = await run("claude auth status");
      return NextResponse.json({ ok: r.ok, output: r.output });
    }

    case "git-config": {
      const name = await run("git config user.name");
      const email = await run("git config user.email");
      const ok = name.ok && email.ok && !!name.output && !!email.output;
      return NextResponse.json({
        ok,
        output: ok ? `${name.output} <${email.output}>` : "Git user.name or user.email not configured",
      });
    }

    case "ssh-access": {
      const r = await run("ssh -T git@github.com -o StrictHostKeyChecking=no -o BatchMode=yes");
      const ok = r.output.includes("successfully authenticated") || r.output.includes("Hi ");
      return NextResponse.json({ ok, output: r.output });
    }

    case "docker": {
      const r = await run("docker --version");
      return NextResponse.json({ ok: r.ok, output: r.output });
    }

    case "api-key": {
      const [keySetting, urlSetting] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "anthropic_api_key" } }),
        prisma.setting.findUnique({ where: { key: "anthropic_base_url" } }),
      ]);
      if (!keySetting?.value) {
        return NextResponse.json({ ok: false, output: "No API key stored" });
      }
      const resolvedBaseUrl = body.baseUrl !== undefined ? body.baseUrl : urlSetting?.value;
      try {
        const client = new Anthropic({
          apiKey: keySetting.value,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
        });
        await client.models.list();
        return NextResponse.json({ ok: true, output: "API key is valid" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, output: msg });
      }
    }

    case "model": {
      const { model: modelId, baseUrl: bodyBaseUrl } = body;
      if (!modelId) return NextResponse.json({ ok: false, output: "No model specified" });
      const [keySetting, urlSetting] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "anthropic_api_key" } }),
        prisma.setting.findUnique({ where: { key: "anthropic_base_url" } }),
      ]);
      if (!keySetting?.value) return NextResponse.json({ ok: false, output: "No API key stored, save one first" });
      const resolvedBaseUrl = bodyBaseUrl !== undefined ? bodyBaseUrl : urlSetting?.value;
      try {
        const client = new Anthropic({
          apiKey: keySetting.value,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
        });
        await client.messages.create({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
        return NextResponse.json({ ok: true, output: `${modelId} is valid` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, output: msg });
      }
    }

    case "openai-key": {
      const [keySetting, urlSetting] = await Promise.all([
        prisma.setting.findUnique({ where: { key: "openai_api_key" } }),
        prisma.setting.findUnique({ where: { key: "openai_base_url" } }),
      ]);
      if (!keySetting?.value) {
        return NextResponse.json({ ok: false, output: "No API key stored" });
      }
      const resolvedBaseUrl = body.baseUrl !== undefined ? body.baseUrl : urlSetting?.value;
      try {
        const client = new OpenAI({
          apiKey: keySetting.value,
          ...(resolvedBaseUrl ? { baseURL: resolvedBaseUrl } : {}),
        });
        const models = await client.models.list();
        const count = models.data.length;
        return NextResponse.json({ ok: true, output: `API key is valid (${count} model${count !== 1 ? "s" : ""} available)` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, output: msg });
      }
    }

    case "test-task": {
      const task = await prisma.task.findFirst({ orderBy: { createdAt: "desc" } });
      const ok = !!task;
      return NextResponse.json({
        ok,
        output: ok ? `Found task: ${task!.title} (status: ${task!.status})` : "No tasks found. Create a task first.",
      });
    }

    default:
      return NextResponse.json({ error: "Unknown step" }, { status: 400 });
  }
}
