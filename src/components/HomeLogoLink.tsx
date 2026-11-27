"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { Bot } from "lucide-react";

interface HomeLogoLinkProps {
  initialHomePage: string;
}

export function HomeLogoLink({ initialHomePage }: HomeLogoLinkProps) {
  const [homePage, setHomePage] = useState(initialHomePage);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const raw = data.home_page;
        setHomePage(!raw || raw === "/" ? "/tasks" : raw);
      })
      .catch(() => {});
  }, []);

  return (
    <Link
      href={homePage}
      className="font-semibold text-lg tracking-tight flex items-center gap-2 shrink-0"
    >
      <Bot size={20} style={{ color: "#E8865A" }} aria-hidden="true" />
      <span className="hidden sm:inline">AI Task Manager</span>
    </Link>
  );
}
