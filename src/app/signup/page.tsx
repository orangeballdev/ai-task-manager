import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/session";
import { signupsEnabled } from "@/lib/auth/http";
import { SignupForm } from "@/components/auth/SignupForm";
import { AuthCard } from "@/components/auth/AuthCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Create account · AI Task Manager" };

export default async function SignupPage() {
  if (await getCurrentSession()) redirect("/");
  if (!(await signupsEnabled())) {
    return (
      <AuthCard title="Sign-ups are closed">
        <p className="text-sm text-muted-foreground">
          New accounts can&apos;t be created on this instance. Ask the owner to enable sign-ups in Settings → Security.
        </p>
        <Link href="/login" className="text-sm underline underline-offset-4">Back to sign in</Link>
      </AuthCard>
    );
  }
  return <SignupForm />;
}
