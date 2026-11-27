"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FolderOpen, LayoutGrid, LayoutList, Rows2, Rows4 } from "lucide-react";
import {
  useViewMode,
  useCompactView,
  useFilesViewMode,
  setViewMode,
  setCompactView,
  setFilesViewMode,
} from "@/lib/use-layout-preferences";

function OptionButton({
  active,
  onClick,
  icon,
  label,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
        active
          ? "border-foreground bg-muted/50"
          : "border-border hover:border-foreground/40 hover:bg-muted/30"
      }`}
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

export default function LayoutPreferences() {
  const viewMode = useViewMode();
  const compactView = useCompactView();
  const filesViewMode = useFilesViewMode();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="card-arrangement" className="text-base scroll-mt-24">Card arrangement</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Choose how task cards are arranged on the page.
          </p>
          <div className="flex gap-3">
            <OptionButton
              active={viewMode === "list"}
              onClick={() => setViewMode("list")}
              icon={<LayoutList className="size-4" />}
              label="List view"
              description="Cards stacked in a single column."
            />
            <OptionButton
              active={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
              icon={<LayoutGrid className="size-4" />}
              label="Grid view"
              description="Cards laid out in a multi-column grid."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="card-density" className="text-base scroll-mt-24">Card density</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Choose how much detail each card shows. Grid view always uses the compact card.
          </p>
          <div className="flex gap-3">
            <OptionButton
              active={!compactView}
              onClick={() => setCompactView(false)}
              icon={<Rows2 className="size-4" />}
              label="Comfortable"
              description="More spacing and detail per card."
            />
            <OptionButton
              active={compactView}
              onClick={() => setCompactView(true)}
              icon={<Rows4 className="size-4" />}
              label="Compact"
              description="Condensed cards to fit more on screen."
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="files-view" className="text-base scroll-mt-24">Files view</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Choose how files are displayed when browsing task workspaces. This preference also syncs with the toggle on the Files page.
          </p>
          <div className="flex gap-3">
            <OptionButton
              active={filesViewMode === "list"}
              onClick={() => setFilesViewMode("list")}
              icon={<LayoutList className="size-4" />}
              label="List"
              description="Files displayed in a detailed list with size and date."
            />
            <OptionButton
              active={filesViewMode === "icons"}
              onClick={() => setFilesViewMode("icons")}
              icon={<FolderOpen className="size-4" />}
              label="Icons"
              description="Files displayed as large icons, like Mac Finder."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
