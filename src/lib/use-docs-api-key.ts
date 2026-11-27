"use client";
// Small shared store (same pattern as src/components/ui/confirm-dialog.tsx) so every
// "Try it" playground on /docs/api reads/writes the same API key without threading state
// through the server page. Persisted to localStorage only — this never touches the DB,
// it just saves the visitor from re-pasting their key for every endpoint.
import { useEffect, useState } from "react";

const STORAGE_KEY = "docs_api_key";
const listeners = new Set<(value: string) => void>();

function readInitial(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

let current = readInitial();

function setShared(value: string) {
  current = value;
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, value);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage may be unavailable (private browsing, etc.) — key still works in-memory for this tab.
  }
  listeners.forEach((l) => l(value));
}

export function useDocsApiKey(): [string, (value: string) => void] {
  const [value, setValue] = useState(current);

  useEffect(() => {
    listeners.add(setValue);
    return () => { listeners.delete(setValue); };
  }, []);

  return [value, setShared];
}
