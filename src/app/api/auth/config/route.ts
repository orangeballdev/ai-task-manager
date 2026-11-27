import { NextResponse } from "next/server";
import { signupsEnabled } from "@/lib/auth/http";

// Public: tells the sign-in page whether to offer "Create an account".
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ signupsEnabled: await signupsEnabled() });
}
