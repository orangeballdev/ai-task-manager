"use client";

export function LocalDateTime({ iso }: { iso: string }) {
  return <>{new Date(iso).toLocaleString()}</>;
}
