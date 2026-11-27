import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { registrationOptionsResponse } from "@/lib/auth/webauthn";

// Step 1 of adding a passkey to the signed-in account.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  return registrationOptionsResponse(req, auth.session.user);
}
