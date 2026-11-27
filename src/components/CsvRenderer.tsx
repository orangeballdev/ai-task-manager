"use client";

import { useState, useMemo } from "react";
import Papa from "papaparse";
import { ArrowUpDown, ArrowUp, ArrowDown, Search } from "lucide-react";

interface CsvRendererProps {
  content: string;
}

export function CsvRenderer({ content }: CsvRendererProps) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filter, setFilter] = useState("");

  const { headers, rows, parseError } = useMemo(() => {
    const result = Papa.parse<string[]>(content.trim(), { skipEmptyLines: true });
    if (result.data.length === 0) {
      return { headers: [], rows: [], parseError: result.errors[0]?.message };
    }
    const [headerRow, ...dataRows] = result.data as string[][];
    return { headers: headerRow ?? [], rows: dataRows, parseError: undefined };
  }, [content]);

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const q = filter.toLowerCase();
    return rows.filter((row) => row.some((cell) => (cell ?? "").toLowerCase().includes(q)));
  }, [rows, filter]);

  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows;
    return [...filteredRows].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const an = parseFloat(av);
      const bn = parseFloat(bv);
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filteredRows, sortCol, sortDir]);

  function toggleSort(col: number) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  }

  if (parseError) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to parse CSV: {parseError}
      </div>
    );
  }

  if (headers.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">Empty CSV file.</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Filter rows…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {sortedRows.length === rows.length
            ? `${rows.length.toLocaleString()} rows · ${headers.length} columns`
            : `${sortedRows.length.toLocaleString()} of ${rows.length.toLocaleString()} rows`}
        </span>
      </div>

      <div className="overflow-auto rounded-lg border border-border max-h-[600px]">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/90 backdrop-blur-sm">
              {headers.map((h, i) => (
                <th
                  key={i}
                  onClick={() => toggleSort(i)}
                  className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap border-b border-border cursor-pointer hover:bg-muted hover:text-foreground transition-colors select-none"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate max-w-[200px]">{h}</span>
                    {sortCol === i ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="size-3 text-foreground shrink-0" />
                      ) : (
                        <ArrowDown className="size-3 text-foreground shrink-0" />
                      )
                    ) : (
                      <ArrowUpDown className="size-3 opacity-30 shrink-0" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, ri) => (
              <tr
                key={ri}
                className={`hover:bg-muted/30 transition-colors ${ri % 2 === 0 ? "bg-background" : "bg-muted/15"}`}
              >
                {headers.map((_, ci) => (
                  <td
                    key={ci}
                    title={row[ci] ?? ""}
                    className="px-3 py-1.5 text-xs text-foreground/90 border-b border-border/40 whitespace-nowrap max-w-[300px] truncate"
                  >
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
            {sortedRows.length === 0 && (
              <tr>
                <td
                  colSpan={headers.length}
                  className="px-3 py-8 text-center text-xs text-muted-foreground"
                >
                  No matching rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
