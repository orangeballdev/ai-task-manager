"use client";
import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { PUBLIC_DOCS_URL } from "@/lib/public-site";

interface MobileNavProps {
  taskBoardEnabled?: boolean;
}

export function MobileNav({ taskBoardEnabled = true }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="sm:hidden text-muted-foreground hover:text-foreground p-1 shrink-0"
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close menu" : "Open menu"}
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 sm:hidden"
            onClick={() => setOpen(false)}
          />
          <div className="fixed top-0 left-0 z-50 h-full w-64 bg-background border-r border-border p-4 flex flex-col sm:hidden">
            <div className="flex items-center justify-between mb-6">
              <span className="font-semibold text-foreground">AI Task Manager</span>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={20} />
              </button>
            </div>
            <nav className="flex flex-col gap-1">
              <Link
                href="/tasks"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Tasks
              </Link>
              {taskBoardEnabled && (
                <Link
                  href="/tasks/kanban"
                  onClick={() => setOpen(false)}
                  className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
                >
                  Board
                </Link>
              )}
              <Link
                href="/analytics"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Analytics
              </Link>
              <Link
                href="/files"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Files
              </Link>
              <Link
                href="/repositories"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Repositories
              </Link>
              <Link
                href="/teams"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Teams
              </Link>
              <Link
                href="/webhooks"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Webhooks
              </Link>
              <a
                href={PUBLIC_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="px-3 py-2 rounded-md hover:bg-muted text-sm transition-colors"
              >
                Docs
              </a>
            </nav>
          </div>
        </>
      )}
    </>
  );
}
