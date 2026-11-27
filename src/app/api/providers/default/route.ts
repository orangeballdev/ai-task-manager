import { NextResponse } from "next/server";
import { getProvider } from "@/lib/smart-provider";

// Which provider would actually be used right now, given the current settings. The task form
// uses this to prefill its provider field instead of guessing from the raw provider list.
export async function GET() {
  const { provider } = await getProvider();
  return NextResponse.json({
    id: provider?.id ?? null,
    name: provider?.name ?? null,
    type: provider?.type ?? null,
  });
}
