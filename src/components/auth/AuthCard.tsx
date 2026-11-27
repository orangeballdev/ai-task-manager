import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Centered card used by the sign-in and sign-up pages. */
export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">AI Task Manager</p>
          <CardTitle className="text-xl">{title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  );
}
