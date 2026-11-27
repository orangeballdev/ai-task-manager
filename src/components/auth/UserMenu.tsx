"use client";
import { useRouter } from "next/navigation";
import { LogOut, Shield, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function UserMenu({ email, name }: { email: string; name: string | null }) {
  const router = useRouter();

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/login");
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="hover:text-foreground transition-colors flex items-center"
        aria-label="Account"
        title={email}
      >
        <UserRound size={20} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col">
            {name && <span className="text-foreground">{name}</span>}
            <span className="text-xs text-muted-foreground truncate">{email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/settings/account")}>
          <UserRound className="size-4" />
          Account &amp; passkeys
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/settings/security")}>
          <Shield className="size-4" />
          Security &amp; sign-in log
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
