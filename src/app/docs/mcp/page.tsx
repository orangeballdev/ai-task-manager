import { ParamsTable } from "@/components/docs/ParamsTable";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { McpSetupSnippets } from "@/components/docs/McpSetupSnippets";
import { Prose, ProseList, ProseTable, renderInline } from "@/components/docs/Prose";
import { MCP_PROMPTS, MCP_TOOLS } from "@/lib/mcp/tools";
import { MCP_DOC as d, MCP_USE_CASES, schemaParams } from "@/lib/docs-content/mcp";

export const metadata = { title: "MCP Server — Docs" };

// All text comes from src/lib/docs-content/mcp.ts, which also feeds the MCP get_docs tool —
// edit it there. The tools/prompts reference is rendered straight from MCP_TOOLS / MCP_PROMPTS,
// so it can't drift from what the server actually exposes.

export default function McpDocsPage() {
  const readTools = MCP_TOOLS.filter((t) => t.access === "read");
  const writeTools = MCP_TOOLS.filter((t) => t.access === "write");

  return (
    <div className="flex flex-col gap-14 pb-24">
      {/* ---------------------------------------------------------------- Overview */}
      <section id="overview" className="scroll-mt-6 flex flex-col gap-4">
        <h1 className="text-3xl font-bold">{d.title}</h1>
        <Prose text={d.intro} className="text-muted-foreground max-w-2xl" />

        <div className="grid sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Endpoint</span>
            <code className="text-sm">/api/mcp</code>
            <span className="text-xs text-muted-foreground">On your own deployment&apos;s origin.</span>
          </div>
          <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Transport</span>
            <span className="text-sm">Streamable HTTP</span>
            <span className="text-xs text-muted-foreground">Stateless, JSON responses.</span>
          </div>
          <div className="rounded-lg border border-border p-4 flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Auth</span>
            <span className="text-sm">OAuth or <code>Bearer tm_mcp_…</code></span>
            <span className="text-xs text-muted-foreground">{renderInline("Sign in from the client, or a token from [Settings → MCP](/settings/mcp).")}</span>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Setup */}
      <section id="setup" className="scroll-mt-6 flex flex-col gap-5">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Setup</h2>

        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Option 1: Sign in with OAuth (recommended)</h3>
          <Prose text={d.oauthIntro} />
          <McpSetupSnippets oauth />
          <ProseList items={d.oauthNotes} />
          <div className="max-w-2xl">
            <ProseTable rows={d.oauthEndpoints} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Option 2: Use an access token</h3>
          <Prose text={d.tokenSectionIntro} />
          <h4 className="font-medium text-sm mt-2">Create an access token</h4>
          <Prose text={d.tokenIntro} />
          <div className="max-w-2xl">
            <ProseTable rows={d.tokenAccess} />
          </div>
          <Prose text={d.tokenNote} />
        </div>

        <div className="flex flex-col gap-2">
          <h4 className="font-medium text-sm">Connect your client</h4>
          <Prose text={d.connectIntro} />
          <McpSetupSnippets />
          <ProseList items={d.connectNotes} />
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Check it works</h3>
          <Prose text={d.checkIntro} />
          <CodeBlock code={d.checkExample} />
          <Prose text={d.checkOutro} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- Use cases */}
      <section id="examples" className="scroll-mt-6 flex flex-col gap-6">
        <div className="flex flex-col gap-2 border-b border-border pb-3">
          <h2 className="text-2xl font-semibold">Examples</h2>
          <Prose text={d.examplesIntro} />
        </div>
        {MCP_USE_CASES.map((uc) => (
          <div key={uc.id} id={`examples-${uc.id}`} className="scroll-mt-6 flex flex-col gap-2">
            <h3 className="font-semibold">{uc.title}</h3>
            <Prose text={uc.intro} />
            <ul className="flex flex-col gap-1.5">
              {uc.prompts.map((p) => (
                <li key={p} className="text-sm rounded-md border border-border bg-muted/30 px-3 py-2 font-mono">
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div id="prompts" className="scroll-mt-6 flex flex-col gap-2">
          <h3 className="font-semibold">Built-in prompts</h3>
          <Prose text={d.promptsIntro} />
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {MCP_PROMPTS.map((p) => (
                  <tr key={p.name}>
                    <td className="align-top px-3 py-2 whitespace-nowrap">
                      <code className="text-xs font-mono">{p.name}</code>
                      {p.access === "write" && <span className="ml-1.5 text-[10px] text-amber-500 align-middle">write</span>}
                    </td>
                    <td className="align-top px-3 py-2 text-muted-foreground">
                      {p.description}
                      {p.arguments?.length ? (
                        <span className="block text-xs mt-0.5">
                          Arguments: {p.arguments.map((a) => `${a.name}${a.required ? "" : " (optional)"}`).join(", ")}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Tools */}
      <section id="tools" className="scroll-mt-6 flex flex-col gap-6">
        <div className="flex flex-col gap-2 border-b border-border pb-3">
          <h2 className="text-2xl font-semibold">Tools reference</h2>
          <Prose text={d.toolsIntro(readTools.length, writeTools.length)} />
        </div>
        {[
          { label: "Read tools", tools: readTools, id: "tools-read" },
          { label: "Write tools", tools: writeTools, id: "tools-write" },
        ].map((group) => (
          <div key={group.id} id={group.id} className="scroll-mt-6 flex flex-col gap-5">
            <h3 className="text-lg font-semibold">{group.label}</h3>
            {group.tools.map((tool) => (
              <div key={tool.name} id={`tool-${tool.name}`} className="scroll-mt-6 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-mono font-semibold px-1.5 py-0.5 rounded ${
                      tool.access === "read" ? "bg-sky-500/15 text-sky-400" : "bg-amber-500/15 text-amber-500"
                    }`}
                  >
                    {tool.access}
                  </span>
                  <code className="text-sm font-mono">{tool.name}</code>
                  <span className="text-sm text-muted-foreground">— {tool.title}</span>
                </div>
                <p className="text-sm text-muted-foreground max-w-2xl">{tool.description}</p>
                <ParamsTable title="Arguments" params={schemaParams(tool.inputSchema)} />
              </div>
            ))}
          </div>
        ))}
      </section>

      {/* ---------------------------------------------------------------- Security & troubleshooting */}
      <section id="security" className="scroll-mt-6 flex flex-col gap-3">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Security</h2>
        <ProseList items={d.security} />
      </section>

      <section id="troubleshooting" className="scroll-mt-6 flex flex-col gap-3">
        <h2 className="text-2xl font-semibold border-b border-border pb-3">Troubleshooting</h2>
        <ProseTable rows={d.troubleshooting} />
      </section>
    </div>
  );
}
