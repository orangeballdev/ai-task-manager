"use client";
import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { DEFAULT_APP_HOST } from "@/lib/app-host";

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

export default function AppHostSetting() {
  const [appHost, setAppHost] = useState(DEFAULT_APP_HOST);
  const savedRef = useRef<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.app_host) setAppHost(data.app_host);
        savedRef.current = data.app_host ?? DEFAULT_APP_HOST;
      })
      .catch(() => {});
  }, []);

  async function commitAppHost() {
    if (!appHost.trim()) {
      toast.error("App Host cannot be empty");
      return;
    }
    if (savedRef.current === appHost) return;
    try {
      await saveSetting("app_host", appHost);
      savedRef.current = appHost;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="app-host" className="text-base scroll-mt-24">App Host</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            The server address used in email and Slack notification links. Defaults to {DEFAULT_APP_HOST}.
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            <Label htmlFor="appHost">App Host (host:port)</Label>
            <Input
              id="appHost"
              type="text"
              value={appHost}
              onChange={(e) => setAppHost(e.target.value)}
              onBlur={commitAppHost}
              placeholder={DEFAULT_APP_HOST}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
