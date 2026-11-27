import Link from "next/link";
import { LlmGatewayBaseUrl, LlmGatewaySnippets } from "@/components/docs/LlmGatewaySnippets";
import { Prose, ProseList, ProseTable } from "@/components/docs/Prose";
import { LLM_GATEWAY_DOC as d } from "@/lib/docs-content/llm-gateway";

export const metadata = { title: "OpenAI / Anthropic-compatible API — Docs" };

// All text comes from src/lib/docs-content/llm-gateway.ts, which also feeds the MCP
// get_docs tool — edit it there, not here.

export default function LlmGatewayDocsPage() {
  return (
    <div className="flex flex-col gap-14 pb-24">
      <section id="overview" className="scroll-mt-6 flex flex-col gap-4">
        <h1 className="text-3xl font-bold">{d.title}</h1>
        <Prose text={d.intro} className="text-muted-foreground max-w-2xl" />

        <div className="grid sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border p-4 flex flex-col gap-1 min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">OpenAI base URL</span>
            <LlmGatewayBaseUrl kind="openai" />
            <span className="text-xs text-muted-foreground">For OpenAI SDKs and tools.</span>
          </div>
          <div className="rounded-lg border border-border p-4 flex flex-col gap-1 min-w-0">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Anthropic base URL</span>
            <LlmGatewayBaseUrl kind="anthropic" />
            <span className="text-xs text-muted-foreground">For Anthropic SDKs and tools.</span>
          </div>
          <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Auth</span>
            <code className="text-sm">tm_live_…</code>
            <span className="text-xs text-muted-foreground">
              Key from <Link href="/settings/api" className="text-primary hover:underline">Settings → API</Link>.
            </span>
          </div>
        </div>
      </section>

      <section id="setup" className="scroll-mt-6 flex flex-col gap-5">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Setup</h2>
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">1. Create an API key</h3>
          <Prose text={d.setupKey} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">2. Check which provider will answer</h3>
          <Prose text={d.setupProvider} />
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">3. Point your client at it</h3>
          <Prose text={d.setupClient} />
          <LlmGatewaySnippets />
          <ProseList items={d.setupNotes} />
        </div>
      </section>

      <section id="models" className="scroll-mt-6 flex flex-col gap-4">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Choosing a model</h2>
        <Prose text={d.modelsIntro} />
        <ProseTable head={d.modelsHead} rows={d.models} />
        <Prose text={d.modelsOutro} />
      </section>

      <section id="providers" className="scroll-mt-6 flex flex-col gap-4">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">What works on each provider</h2>
        <Prose text={d.providersIntro} />
        <ProseTable head={d.providersHead} rows={d.providers} />
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Translation notes</h3>
          <ProseList items={d.translationNotes} />
        </div>
      </section>

      <section id="endpoints" className="scroll-mt-6 flex flex-col gap-4">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Endpoints</h2>
        <ProseTable head={d.endpointsHead} rows={d.endpoints} />
      </section>

      <section id="errors" className="scroll-mt-6 flex flex-col gap-4">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Errors</h2>
        <Prose text={d.errorsIntro} />
        <ProseTable head={d.errorsHead} rows={d.errors} />
      </section>

      <section id="notes" className="scroll-mt-6 flex flex-col gap-3">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Good to know</h2>
        <ProseList items={d.notes} />
      </section>
    </div>
  );
}
