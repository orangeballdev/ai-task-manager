"use client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmailDeliveryCard } from "@/components/settings/EmailDeliveryCard";

interface NotificationSettings {
  notification_email_enabled: string;
  notification_email_address: string;
  notification_on_completed: string;
  notification_on_failed: string;
  notification_on_provider_auth_failed: string;
  notification_on_low_usage_warning: string;
  notification_on_file_deletion: string;
}

async function saveSetting(key: string, value: string) {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

export default function NotificationsSettingsPage() {
  const [settings, setSettings] = useState<NotificationSettings>({
    notification_email_enabled: "false",
    notification_email_address: "",
    notification_on_completed: "true",
    notification_on_failed: "true",
    notification_on_provider_auth_failed: "true",
    notification_on_low_usage_warning: "false",
    notification_on_file_deletion: "true",
  });
  const [loading, setLoading] = useState(true);
  const [testSending, setTestSending] = useState(false);
  // Last value persisted per key, so committing an unchanged field is a no-op.
  const savedRef = useRef<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        const loaded: NotificationSettings = {
          notification_email_enabled: data.notification_email_enabled ?? "false",
          notification_email_address: data.notification_email_address ?? "",
          notification_on_completed: data.notification_on_completed ?? "true",
          notification_on_failed: data.notification_on_failed ?? "true",
          notification_on_provider_auth_failed: data.notification_on_provider_auth_failed ?? "true",
          notification_on_low_usage_warning: data.notification_on_low_usage_warning ?? "false",
          notification_on_file_deletion: data.notification_on_file_deletion ?? "true",
        };
        setSettings(loaded);
        savedRef.current = { ...loaded };
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const emailEnabled = settings.notification_email_enabled === "true";

  // Persist a single setting key, skipping the request when unchanged.
  async function commit(key: keyof NotificationSettings, value: string) {
    if (savedRef.current[key] === value) return;
    try {
      await saveSetting(key, value);
      savedRef.current[key] = value;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  async function handleSendTest() {
    if (!settings.notification_email_address.trim()) {
      toast.error("Enter an email address first");
      return;
    }
    setTestSending(true);
    try {
      const res = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: settings.notification_email_address.trim() }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        toast.success("Test email sent");
      } else {
        toast.error(data.error ?? "Failed to send test email");
      }
    } catch {
      toast.error("Failed to send test email");
    } finally {
      setTestSending(false);
    }
  }

  function toggle(key: keyof NotificationSettings) {
    setSettings((prev) => {
      const next = prev[key] === "true" ? "false" : "true";
      void commit(key, next);
      return { ...prev, [key]: next };
    });
  }

  function commitEmailAddress() {
    const value = settings.notification_email_address.trim();
    if (emailEnabled && !value) {
      toast.error("Please enter an email address");
      return;
    }
    void commit("notification_email_address", value);
  }

  if (loading) {
    return <div className="h-48 bg-muted rounded animate-pulse" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">About Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Notifications alert you when your tasks complete or fail. Configure how and where
            you want to be notified so you can stay informed without watching the dashboard.
          </p>
        </CardContent>
      </Card>

      <EmailDeliveryCard />

      <Card>
        <CardHeader>
          <CardTitle id="email-notifications" className="text-base scroll-mt-24">Email Notifications</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Receive email notifications.
          </p>

          <label className="flex items-center gap-3 cursor-pointer">
            <div
              role="switch"
              aria-checked={emailEnabled}
              onClick={() => toggle("notification_email_enabled")}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                emailEnabled ? "bg-primary" : "bg-muted-foreground/30"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg transition-transform ${
                  emailEnabled ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </div>
            <span className="text-sm font-medium">Enable email notifications</span>
          </label>

          {emailEnabled && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email-address">Recipient email address</Label>
                <div className="flex gap-2">
                  <Input
                    id="email-address"
                    type="email"
                    value={settings.notification_email_address}
                    onChange={(e) => setSettings((prev) => ({ ...prev, notification_email_address: e.target.value }))}
                    onBlur={commitEmailAddress}
                    placeholder="you@example.com"
                    className="max-w-sm"
                  />
                  <Button variant="outline" size="sm" onClick={handleSendTest} disabled={testSending}>
                    {testSending ? "Sending…" : "Send test"}
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Notify me when</p>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.notification_on_completed === "true"}
                    onChange={() => toggle("notification_on_completed")}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary"
                  />
                  <span className="text-sm">Task completed successfully</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.notification_on_failed === "true"}
                    onChange={() => toggle("notification_on_failed")}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary"
                  />
                  <span className="text-sm">Task failed</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.notification_on_provider_auth_failed === "true"}
                    onChange={() => toggle("notification_on_provider_auth_failed")}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary"
                  />
                  <span className="text-sm">Provider authentication failed (expired credentials)</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.notification_on_low_usage_warning === "true"}
                    onChange={() => toggle("notification_on_low_usage_warning")}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary"
                  />
                  <span className="text-sm">Usage quota drops below 50% with less than 48 hours until renewal</span>
                </label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.notification_on_file_deletion === "true"}
                    onChange={() => toggle("notification_on_file_deletion")}
                    className="size-4 rounded border-2 border-muted-foreground accent-primary"
                  />
                  <span className="text-sm">Files are about to be automatically deleted (file retention cleanup)</span>
                </label>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
