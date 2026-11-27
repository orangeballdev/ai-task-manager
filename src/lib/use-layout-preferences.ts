"use client";
import { useSyncExternalStore } from "react";

export type ViewMode = "list" | "grid";
export type FilesViewMode = "list" | "icons";

const VIEW_MODE_KEY = "tasks-view-mode";
const COMPACT_KEY = "task-list-compact";
const FILES_VIEW_MODE_KEY = "files-view-mode";
const KANBAN_COLLAPSED_KEY = "kanban-collapsed-columns";
const CHANGE_EVENT = "layout-preferences-change";

function emitChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  // Keep tabs/windows in sync when the preference changes elsewhere.
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getViewMode(): ViewMode {
  if (typeof window === "undefined") return "list";
  return localStorage.getItem(VIEW_MODE_KEY) === "grid" ? "grid" : "list";
}

export function getCompactView(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(COMPACT_KEY) === "true";
}

export function setViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch { /* ignore */ }
  emitChange();
}

export function setCompactView(value: boolean): void {
  try {
    localStorage.setItem(COMPACT_KEY, String(value));
  } catch { /* ignore */ }
  emitChange();
}

export function getFilesViewMode(): FilesViewMode {
  if (typeof window === "undefined") return "list";
  return localStorage.getItem(FILES_VIEW_MODE_KEY) === "icons" ? "icons" : "list";
}

export function setFilesViewMode(mode: FilesViewMode): void {
  try {
    localStorage.setItem(FILES_VIEW_MODE_KEY, mode);
  } catch { /* ignore */ }
  emitChange();
}

/** Reactive read of the list/grid card layout preference. */
export function useViewMode(): ViewMode {
  return useSyncExternalStore(subscribe, getViewMode, () => "list");
}

/** Reactive read of the compact/comfortable card density preference. */
export function useCompactView(): boolean {
  return useSyncExternalStore(subscribe, getCompactView, () => false);
}

/** Reactive read of the files list/icons view preference. */
export function useFilesViewMode(): FilesViewMode {
  return useSyncExternalStore(subscribe, getFilesViewMode, () => "list");
}

const EMPTY_COLLAPSED: string[] = [];

let cachedRaw: string | null = null;
let cachedColumns: string[] = EMPTY_COLLAPSED;

// useSyncExternalStore compares snapshots by reference, so this must return the
// same array instance when the underlying localStorage value hasn't changed —
// otherwise React sees a "new" snapshot every render and loops forever (error #185).
function getCollapsedKanbanColumns(): string[] {
  if (typeof window === "undefined") return EMPTY_COLLAPSED;
  const raw = localStorage.getItem(KANBAN_COLLAPSED_KEY);
  if (raw === cachedRaw) return cachedColumns;
  cachedRaw = raw;
  try {
    if (!raw) {
      cachedColumns = EMPTY_COLLAPSED;
    } else {
      const parsed = JSON.parse(raw);
      cachedColumns = Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : EMPTY_COLLAPSED;
    }
  } catch {
    cachedColumns = EMPTY_COLLAPSED;
  }
  return cachedColumns;
}

function setCollapsedKanbanColumns(keys: string[]): void {
  try {
    localStorage.setItem(KANBAN_COLLAPSED_KEY, JSON.stringify(keys));
  } catch { /* ignore */ }
  emitChange();
}

/**
 * Reactive read of which kanban swim lanes (columns) are collapsed, persisted to
 * localStorage so the board remembers the layout next time it's viewed.
 */
export function useCollapsedKanbanColumns(): string[] {
  return useSyncExternalStore(subscribe, getCollapsedKanbanColumns, () => EMPTY_COLLAPSED);
}

/** Toggle a kanban column's collapsed state and persist it. */
export function toggleKanbanColumnCollapsed(key: string): void {
  const current = getCollapsedKanbanColumns();
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  setCollapsedKanbanColumns(next);
}
