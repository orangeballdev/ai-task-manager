import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/policy";
import { signupsEnabled } from "@/lib/auth/http";
import { LoginForm } from "@/components/auth/LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · AI Task Manager" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = safeNextPath(typeof sp.next === "string" ? sp.next : "/");
  if (await getCurrentSession()) redirect(next);
  return <LoginForm next={next} signupsEnabled={await signupsEnabled()} />;
}
