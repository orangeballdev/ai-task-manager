import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import {
  runWithApi,
  runWithCli,
  runWithOpenAI,
  type ChatMessage,
  type ChatbotLevel,
  type ProposedTask,
} from "@/lib/chat";
import { traceLlmCall } from "@/lib/gen-ai-otel";

async function getRepoHistory(): Promise<{ url: string; alias: string }[]> {
  return prisma.taskRepo.findMany({
    select: { url: true, alias: true },
    distinct: ["url"],
    orderBy: { id: "desc" },
    take: 20,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { messages: ChatMessage[]; providerId?: string; model?: string; gitContext?: string; selectedRepoUrl?: string; level?: ChatbotLevel };
  const { messages, providerId, model: modelOverride, gitContext, selectedRepoUrl, level } = body;

  if (!messages?.length) {
    return NextResponse.json({ error: "messages are required" }, { status: 400 });
  }

  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });
  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  const repoHistory = await getRepoHistory();

  // Use the level passed from the client (which reads from settings), default to "low"
  const effectiveLevel: ChatbotLevel = level ?? "low";

  try {
    let result: { reply: string; proposedTask?: ProposedTask };

    const effectiveModel = modelOverride || provider.model || undefined;

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      }
      result = await traceLlmCall({ feature: "task-chat", provider: provider, model: effectiveModel }, () => runWithApi(messages, apiKey, provider.baseUrl || undefined, effectiveModel, gitContext || undefined, repoHistory, effectiveLevel, selectedRepoUrl || undefined));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      }
      result = await traceLlmCall({ feature: "task-chat", provider: provider, model: effectiveModel }, () => runWithOpenAI(messages, apiKey, provider.baseUrl || undefined, effectiveModel, gitContext || undefined, repoHistory, effectiveLevel, selectedRepoUrl || undefined));
    } else {
      result = await traceLlmCall({ feature: "task-chat", provider: provider, model: effectiveModel }, () => runWithCli(messages, provider.configDir || undefined, effectiveModel, provider.credentialsJson || undefined, gitContext || undefined, repoHistory, effectiveLevel, selectedRepoUrl || undefined, provider.type));
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
