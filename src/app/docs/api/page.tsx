import { API_ENDPOINTS } from "@/lib/api-endpoints";
import { ParamsTable } from "@/components/docs/ParamsTable";
import { EndpointPlayground } from "@/components/docs/EndpointPlayground";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { Prose } from "@/components/docs/Prose";
import { API_DOC } from "@/lib/docs-content/api";

const METHOD_COLOR: Record<string, string> = {
  GET: "bg-sky-500/15 text-sky-400",
  POST: "bg-emerald-500/15 text-emerald-400",
  PATCH: "bg-amber-500/15 text-amber-400",
};

export const metadata = { title: "API Reference — Docs" };

// Overview text lives in src/lib/docs-content/api.ts (shared with the MCP get_docs tool);
// the endpoints come from API_ENDPOINTS.

export default function ApiDocsPage() {
  return (
    <div className="flex flex-col gap-14 pb-24">
      <section id="overview" className="scroll-mt-6 flex flex-col gap-4">
        <h1 className="text-3xl font-bold">{API_DOC.title}</h1>
        <Prose text={API_DOC.intro} className="text-muted-foreground max-w-2xl" />

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <h2 className="text-sm font-semibold">Authentication</h2>
          <Prose text={API_DOC.auth} className="text-sm text-muted-foreground" />
          <CodeBlock code={API_DOC.authHeader} />
          <Prose text={API_DOC.authNote} className="text-xs text-muted-foreground" />
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">Base URL</h2>
          <Prose text={API_DOC.baseUrl("https://your-app.example.com")} className="text-sm text-muted-foreground" />
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">Errors</h2>
          <Prose text={API_DOC.errors} className="text-sm text-muted-foreground" />
          <CodeBlock code={API_DOC.errorExample} />
        </div>
      </section>

      {API_ENDPOINTS.map((endpoint) => (
        <section key={endpoint.id} id={endpoint.id} className="scroll-mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-2 border-b border-border pb-4">
            <div className="flex items-center gap-2">
              <span className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded ${METHOD_COLOR[endpoint.method]}`}>
                {endpoint.method}
              </span>
              <code className="text-sm font-mono text-muted-foreground">{endpoint.path}</code>
            </div>
            <h2 className="text-xl font-semibold">{endpoint.summary}</h2>
            <p className="text-sm text-muted-foreground max-w-2xl whitespace-pre-line">{endpoint.description}</p>
          </div>

          <div className="grid gap-4">
            {endpoint.pathParams && <ParamsTable title="Path parameters" params={endpoint.pathParams} />}
            {endpoint.queryParams && <ParamsTable title="Query parameters" params={endpoint.queryParams} />}
            {endpoint.bodyParams && <ParamsTable title="Body parameters" params={endpoint.bodyParams} />}
          </div>

          <EndpointPlayground endpoint={endpoint} />
        </section>
      ))}
    </div>
  );
}
