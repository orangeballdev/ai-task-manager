import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { BookOpen, KeyRound, ArrowRight, Plug, Sparkles } from "lucide-react";

export default function DocsIndexPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Documentation</h1>
        <p className="text-muted-foreground max-w-2xl">
          Everything you need to drive the Task Manager from outside the UI — create tasks,
          kick them off, and pull results back into your own tools — either from code with the
          REST API, or by chatting with an AI assistant through the MCP server.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <Link href="/docs/api" className="group">
          <Card className="h-full transition-colors group-hover:border-foreground/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen className="size-4 text-muted-foreground" /> API Reference
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Create a task, start it, and check its results — with copy-pasteable
                cURL/JS/Python samples and a live &quot;Try it&quot; console you can run
                right from this site.
              </p>
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                Read the docs <ArrowRight className="size-3.5" />
              </span>
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings/api" className="group">
          <Card className="h-full transition-colors group-hover:border-foreground/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4 text-muted-foreground" /> API Keys
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Every request to the public API needs a key. Create and revoke them under
                Settings.
              </p>
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                Manage API keys <ArrowRight className="size-3.5" />
              </span>
            </CardContent>
          </Card>
        </Link>
        <Link href="/docs/mcp" className="group">
          <Card className="h-full transition-colors group-hover:border-foreground/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className="size-4 text-muted-foreground" /> MCP Server
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Connect Claude Code, Claude Desktop, Cursor or VS Code and ask questions about
                your tasks, create and edit them, and review results — from a chat.
              </p>
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                Set up MCP <ArrowRight className="size-3.5" />
              </span>
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings/mcp" className="group">
          <Card className="h-full transition-colors group-hover:border-foreground/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4 text-muted-foreground" /> MCP Tokens
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                MCP clients authenticate with read-only or read &amp; write access tokens.
                Create, change and revoke them under Settings.
              </p>
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                Manage MCP tokens <ArrowRight className="size-3.5" />
              </span>
            </CardContent>
          </Card>
        </Link>
        <Link href="/docs/llm-gateway" className="group">
          <Card className="h-full transition-colors group-hover:border-foreground/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4 text-muted-foreground" /> OpenAI / Anthropic-compatible API
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Point any tool built for the OpenAI or Anthropic API at the Task Manager and it runs on
                your default AI provider. Change the base URL and the key, and nothing else.
              </p>
              <span className="inline-flex items-center gap-1 text-sm text-primary">
                Connect a service <ArrowRight className="size-3.5" />
              </span>
            </CardContent>
          </Card>
        </Link>
      </div>

      <Link href="/docs/api" className={buttonVariants({ size: "sm" }) + " w-fit"}>
        Get started with the API
      </Link>
    </div>
  );
}
