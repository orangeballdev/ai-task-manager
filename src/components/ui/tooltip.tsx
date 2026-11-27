import { type ReactNode } from "react";

export function Tooltip({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="relative group/tip">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 whitespace-nowrap rounded bg-popover border border-border px-2 py-1 text-xs text-popover-foreground shadow-md opacity-0 group-hover/tip:opacity-100 transition-opacity z-50">
        {label}
      </div>
    </div>
  );
}
