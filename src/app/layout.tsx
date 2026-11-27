import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { readFileSync } from "fs";
import { join } from "path";
import { Settings } from "lucide-react";
import { prisma } from "@/lib/db";
import { AboutButton } from "@/components/AboutModal";
import { MobileNav } from "@/components/MobileNav";
import { HealthIndicator } from "@/components/HealthIndicator";
import { NavSearch } from "@/components/NavSearch";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";
import { buttonVariants } from "@/components/ui/button";
import { RunningTasksTitle } from "@/components/RunningTasksTitle";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { HomeLogoLink } from "@/components/HomeLogoLink";
import { NavigationGuard } from "@/components/NavigationGuard";
import { WebAnalytics } from "@/components/WebAnalytics";
import { UserMenu } from "@/components/auth/UserMenu";
import { getCurrentSession } from "@/lib/auth/session";
import { authRequired } from "@/lib/auth/http";
import { PUBLIC_DOCS_URL } from "@/lib/public-site";
import { USER_MONITORING_KEYS, resolveUserMonitoring } from "@/lib/user-monitoring";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the page draw under the iPhone notch/Dynamic Island and home
  // indicator so we can control safe-area padding ourselves (see globals.css).
  viewportFit: "cover",
  themeColor: "#09090b",
  colorScheme: "dark",
};

export const metadata: Metadata = {
  title: "AI Task Manager",
  description: "Orchestrate autonomous AI coding agents",
  applicationName: "AI Task Manager",
  // iOS Safari ignores manifest.json for "Add to Home Screen" and instead
  // relies on these apple-specific tags plus the apple-icon.png convention.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AI Task Manager",
  },
  formatDetection: {
    telephone: false,
  },
  other: {
    // Older iOS/Safari versions (pre-17.4) only honor the vendor-prefixed
    // tag; Next.js's `appleWebApp.capable` above only emits the newer
    // standard "mobile-web-app-capable" tag, so add this one directly.
    "apple-mobile-web-app-capable": "yes",
  },
};

function getBuildTime(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), "src/generated/build-info.json"), "utf-8");
    return JSON.parse(raw).buildTime ?? null;
  } catch {
    return null;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session && (await authRequired())) {
    // Signed out (and sign-in is required): only /login, /signup (and other public pages) can render here — the
    // proxy redirects everything else. Skip the nav and its polling widgets, whose
    // API calls would just 401.
    return (
      <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} antialiased dark`}>
        <body className="min-h-screen flex flex-col bg-background text-foreground">
          <main className="flex-1 p-3 sm:p-6">{children}</main>
          <Toaster />
        </body>
      </html>
    );
  }

  const buildTime = getBuildTime();
  const homePageSetting = await prisma.setting.findUnique({ where: { key: "home_page" } });
  const rawHomePage = homePageSetting?.value;
  const homePage = !rawHomePage || rawHomePage === "/" ? "/tasks" : rawHomePage;
  const taskBoardSetting = await prisma.setting.findUnique({ where: { key: "task_board_enabled" } });
  const taskBoardEnabled = taskBoardSetting?.value !== "false";
  const monitoringRows = await prisma.setting.findMany({ where: { key: { in: Object.values(USER_MONITORING_KEYS) } } });
  const userMonitoring = resolveUserMonitoring(Object.fromEntries(monitoringRows.map((r: { key: string; value: string }) => [r.key, r.value])));

  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} antialiased dark`}>
      <body className="min-h-screen flex flex-col bg-background text-foreground">
        <header id="site-header" className="border-b border-border px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-6 shrink-0">
          <MobileNav taskBoardEnabled={taskBoardEnabled} />
          <HomeLogoLink initialHomePage={homePage} />
          <nav className="flex items-center gap-2 sm:gap-4 text-sm text-muted-foreground flex-1 min-w-0">
            <Link href="/tasks" className="hover:text-foreground transition-colors hidden sm:block shrink-0">Tasks</Link>
            {taskBoardEnabled && <Link href="/tasks/kanban" className="hover:text-foreground transition-colors hidden md:block shrink-0">Board</Link>}
            <Link href="/analytics" className="hover:text-foreground transition-colors hidden md:block shrink-0">Analytics</Link>
            <Link href="/files" className="hover:text-foreground transition-colors hidden md:block shrink-0">Files</Link>
            <Link href="/repositories" className="hover:text-foreground transition-colors hidden md:block shrink-0">Repositories</Link>
            <Link href="/teams" className="hover:text-foreground transition-colors hidden md:block shrink-0">Teams</Link>
            <Link href="/webhooks" className="hover:text-foreground transition-colors hidden md:block shrink-0">Webhooks</Link>
            <a href={PUBLIC_DOCS_URL} target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors hidden md:block shrink-0">Docs</a>
            <Link href="/tasks/new" className={buttonVariants({ size: "sm" }) + " shrink-0 whitespace-nowrap"}>+ New Task</Link>
            <div className="ml-auto flex items-center gap-3 sm:gap-4 shrink-0">
              <NavSearch />
              <HealthIndicator />
              <AboutButton buildTime={buildTime} />
              <Link href="/settings" className="hover:text-foreground transition-colors" aria-label="Settings"><Settings size={20} /></Link>
              {session ? (
                <UserMenu email={session.user.email} name={session.user.name} />
              ) : (
                <Link href="/login" className="hover:text-foreground transition-colors whitespace-nowrap">Sign in</Link>
              )}
            </div>
          </nav>
        </header>
        <RunningTasksTitle />
        <KeyboardShortcuts />
        <NavigationGuard />
        {userMonitoring && <WebAnalytics apiKey={userMonitoring.apiKey} host={userMonitoring.host} />}
        {session?.user.mustChangePassword && (
          <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 sm:px-6 py-2 text-sm text-amber-200">
            You&apos;re still using the initial password for {session.user.email}.{" "}
            <Link href="/settings/account" className="underline underline-offset-4">Change it now</Link>
            {" "}— and consider adding a passkey.
          </div>
        )}
        <main className="flex-1 p-3 sm:p-6">{children}</main>
        <Toaster />
        <ConfirmDialogHost />
      </body>
    </html>
  );
}
