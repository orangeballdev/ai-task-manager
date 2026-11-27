import { NextRequest, NextResponse } from "next/server";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import { getSavedRepos } from "@/lib/repos";
import {
  runRepoChatWithApi,
  runRepoChatWithCli,
  runRepoChatWithOpenAI,
  type ChatMessage,
  type RepoChatTarget,
} from "@/lib/repo-chat";
import { traceLlmCall } from "@/lib/gen-ai-otel";

/**
 * Q&A about a single repository. The client owns the repo snapshot (it loads it
 * once from /api/tasks/git-context and replays it here) so asking a follow-up
 * question doesn't re-clone the repo on every message.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as {
    messages?: ChatMessage[];
    repoUrl?: string;
    repoAlias?: string;
    gitContext?: string;
    providerId?: string;
    model?: string;
  };
  const { messages, repoUrl, repoAlias, gitContext, providerId, model: modelOverride } = body;

  if (!messages?.length) {
    return NextResponse.json({ error: "messages are required" }, { status: 400 });
  }
  if (!repoUrl?.trim()) {
    return NextResponse.json({ error: "repoUrl is required" }, { status: 400 });
  }

  // Omitting providerId falls through to the app's global provider selection
  // (smart picker → default connection), so the chat "just works" with whatever
  // is configured in Settings → AI unless the user picks something else.
  const { provider, throttledFallback } = await getProvider({ explicitProviderId: providerId });
  if (!provider) {
    return NextResponse.json({ error: providerUnavailableMessage(throttledFallback) }, { status: 400 });
  }

  // Pull the repo's saved "default context" server-side so the assistant always
  // gets the user's standing notes, even though the client never sends them.
  const saved = (await getSavedRepos()).find((r) => r.url === repoUrl.trim());

  const repo: RepoChatTarget = {
    url: repoUrl.trim(),
    alias: repoAlias?.trim() || saved?.alias,
    defaultContext: saved?.defaultContext,
    gitContext: gitContext || undefined,
  };

  const effectiveModel = modelOverride || provider.model || undefined;

  try {
    let result: { reply: string };

    if (provider.type === "api") {
      const apiKey = provider.apiKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      }
      result = await traceLlmCall({ feature: "repo-chat", provider: provider, model: effectiveModel }, () => runRepoChatWithApi(messages, repo, apiKey, provider.baseUrl || undefined, effectiveModel));
    } else if (provider.type === "openai") {
      const apiKey = provider.apiKey || process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return NextResponse.json({ error: "No API key configured for this provider." }, { status: 400 });
      }
      result = await traceLlmCall({ feature: "repo-chat", provider: provider, model: effectiveModel }, () => runRepoChatWithOpenAI(messages, repo, apiKey, provider.baseUrl || undefined, effectiveModel));
    } else {
      result = await traceLlmCall({ feature: "repo-chat", provider: provider, model: effectiveModel }, () => runRepoChatWithCli(
        messages,
        repo,
        provider.configDir || undefined,
        effectiveModel,
        provider.credentialsJson || undefined,
        provider.type,
      ));
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Chat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
