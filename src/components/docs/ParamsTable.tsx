import type { ApiParam } from "@/lib/api-endpoints";

export function ParamsTable({ title, params }: { title: string; params: ApiParam[] }) {
  if (params.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <tbody className="divide-y divide-border">
            {params.map((p) => (
              <tr key={p.name}>
                <td className="align-top px-3 py-2 whitespace-nowrap">
                  <code className="text-xs font-mono">{p.name}</code>
                  {p.required && <span className="ml-1.5 text-[10px] text-destructive align-middle">required</span>}
                </td>
                <td className="align-top px-3 py-2 whitespace-nowrap text-muted-foreground text-xs font-mono">{p.type}</td>
                <td className="align-top px-3 py-2 text-muted-foreground">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
