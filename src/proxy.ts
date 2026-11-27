// Authentication gate for the whole app (Next.js 16 "proxy", formerly middleware;
// runs on the Node.js runtime so it can check the session in the database).
//
// When sign-in is turned off (Settings → Security, the `auth_required` Setting — off on
// fresh installs) every request is let through. Otherwise every request needs a valid browser session except the paths in isPublicPath()
// (src/lib/auth/policy.ts) — sign-in pages, static assets, and endpoints that
// enforce their own credential (API keys, MCP/OAuth tokens, webhook secrets).
// Unauthenticated page loads are redirected to /login?next=…; API calls get a 401.
import { NextRequest, NextResponse } from "next/server";
import { isApiPath, isPublicPath, SESSION_COOKIE } from "@/lib/auth/policy";
import { findSession } from "@/lib/auth/session";
import { authRequired } from "@/lib/auth/http";

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (!(await authRequired())) return NextResponse.next();

  const session = await findSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (isApiPath(pathname)) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
