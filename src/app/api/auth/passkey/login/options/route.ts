import { NextRequest } from "next/server";
import { authenticationOptionsResponse } from "@/lib/auth/webauthn";

// Public: step 1 of signing in with a passkey.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return authenticationOptionsResponse(req);
}
