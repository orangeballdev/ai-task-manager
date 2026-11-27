import { DocsSidebar } from "@/components/docs/DocsSidebar";
import { DocsSearch } from "@/components/docs/DocsSearch";
import { docsSearchIndex } from "@/lib/docs-content";
import { MCP_PROMPTS, MCP_TOOLS } from "@/lib/mcp/tools";

// The search index is the same markdown the MCP get_docs tool serves, built once per render on
// the server and searched client-side. The origin only appears in URLs inside code samples.
const SEARCH_ORIGIN = "https://your-app.example.com";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const searchIndex = docsSearchIndex(SEARCH_ORIGIN, { tools: MCP_TOOLS, prompts: MCP_PROMPTS });

  return (
    <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-8">
      <aside className="md:w-56 shrink-0 md:sticky md:top-6 md:self-start flex flex-col gap-4">
        <DocsSearch index={searchIndex} />
        <DocsSidebar />
      </aside>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
