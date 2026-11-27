"use client";
import { Fragment, useState, useEffect } from "react";
import { fetchJson } from "@/lib/fetch-json";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Trash2,
  Plus,
  Star,
  Users,
  ShieldCheck,
} from "lucide-react";
import { confirm } from "@/components/ui/confirm-dialog";
import { getAnalytics } from "@/components/WebAnalytics";

interface TeamMember {
  id: string;
  teamId: string;
  name: string;
  instructions: string;
  position: number;
  requiresApproval: boolean;
}

type MemberUpdate = { name: string; instructions: string; requiresApproval: boolean };

interface Team {
  id: string;
  name: string;
  isDefault: boolean;
  members: TeamMember[];
}

const APPROVAL_HELP =
  "Pause the pipeline after this member and wait for you to approve its output (or request changes) from the task page before the next member starts.";

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** Add/edit a team member. `member` null = adding a new one. */
function MemberDialog({
  open,
  onOpenChange,
  member,
  isLast,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: TeamMember | null;
  /** Whether the member is (or, when adding, will be) the last stage of the pipeline. */
  isLast: boolean;
  onSubmit: (data: MemberUpdate) => Promise<boolean>;
}) {
  // The parent remounts this dialog (via `key`) every time it opens, so the form
  // starts from the member being edited without syncing state in an effect.
  const [name, setName] = useState(member?.name ?? "");
  const [instructions, setInstructions] = useState(member?.instructions ?? "");
  const [requiresApproval, setRequiresApproval] = useState(member?.requiresApproval ?? false);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("Role name is required");
      return;
    }
    setSaving(true);
    try {
      const ok = await onSubmit({ name: name.trim(), instructions: instructions.trim(), requiresApproval });
      if (ok) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  const idPrefix = member ? `member-${member.id}` : "member-new";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{member ? "Edit member" : "Add member"}</DialogTitle>
          <DialogDescription>Each member runs as one stage of the pipeline, in order.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 mt-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>Role</Label>
            <Input
              id={`${idPrefix}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Planner, Coder, Tester"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-instructions`}>Instructions</Label>
            <Textarea
              id={`${idPrefix}-instructions`}
              rows={8}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Break the task down into a concrete implementation plan"
              className="text-sm max-h-[50vh]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Switch id={`${idPrefix}-approval`} checked={requiresApproval} onCheckedChange={setRequiresApproval} />
              <Label htmlFor={`${idPrefix}-approval`} className="font-normal">Wait for my approval before the next member</Label>
            </div>
            <p className="text-xs text-muted-foreground pl-11">
              {requiresApproval && isLast
                ? "This is the last member, so there's no next member to hold back — the finished task goes to review as usual."
                : APPROVAL_HELP}
            </p>
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Saving..." : member ? "Save" : "Add member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Create or rename a team. Remounted (via `key`) each time it opens, like MemberDialog. */
function TeamNameDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initialName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initialName: string;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    setSaving(true);
    try {
      if (await onSubmit(name.trim())) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 mt-2">
          <Label htmlFor="team-name">Name</Label>
          <Input
            id="team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
            placeholder="e.g. Standard Dev Pipeline"
            autoFocus
          />
        </div>
        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={saving}>{saving ? "Saving..." : submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function MemberRow({
  member,
  index,
  onEdit,
  onDelete,
}: {
  member: TeamMember;
  index: number;
  onEdit: (member: TeamMember) => void;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: member.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 hover:bg-muted/40"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground shrink-0"
        aria-label="Drag to reorder"
      >
        <GripVertical className="size-4" />
      </button>
      <span className="text-xs text-muted-foreground tabular-nums w-4 text-right shrink-0">{index + 1}</span>
      <button
        type="button"
        onClick={() => onEdit(member)}
        className="flex-1 min-w-0 flex items-center gap-2 text-left"
        title={member.instructions || undefined}
      >
        <span className="text-sm font-medium shrink-0">{member.name}</span>
        {member.requiresApproval && (
          <ShieldCheck className="size-3.5 text-amber-500 shrink-0" aria-label="Needs approval" />
        )}
        {member.instructions && (
          <span className="text-xs text-muted-foreground truncate">{member.instructions}</span>
        )}
      </button>
      <div className="flex items-center gap-0.5 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <Button variant="ghost" size="icon" className="size-7" onClick={() => onEdit(member)} aria-label="Edit member">
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive hover:text-destructive"
          onClick={() => onDelete(member.id)}
          aria-label="Remove member"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** One-line "Planner → Coder → Tester" summary shown while a team is collapsed. */
function PipelineSummary({ members }: { members: TeamMember[] }) {
  if (members.length === 0) {
    return <span className="text-xs text-muted-foreground italic">No members yet</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      {members.map((m, i) => (
        <Fragment key={m.id}>
          {i > 0 && <span aria-hidden>→</span>}
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-foreground/80">
            {m.name}
            {m.requiresApproval && <ShieldCheck className="size-3 text-amber-500" aria-label="Needs approval" />}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Team card
// ---------------------------------------------------------------------------

function TeamCard({
  team,
  defaultExpanded,
  onRename,
  onSetDefault,
  onDelete,
  onMembersChange,
}: {
  team: Team;
  defaultExpanded: boolean;
  onRename: (id: string, name: string) => Promise<boolean>;
  onSetDefault: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  onMembersChange: (teamId: string, members: TeamMember[]) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [renameOpen, setRenameOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [dialogKey, setDialogKey] = useState(0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function openAddMember() {
    setEditingMember(null);
    setDialogKey((k) => k + 1);
    setMemberDialogOpen(true);
    setExpanded(true);
  }

  function openEditMember(member: TeamMember) {
    setEditingMember(member);
    setDialogKey((k) => k + 1);
    setMemberDialogOpen(true);
  }

  async function handleAddMember(data: MemberUpdate): Promise<boolean> {
    const res = await fetch(`/api/teams/${team.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      toast.error(err.error ?? "Failed to add member");
      return false;
    }
    const created = await res.json() as TeamMember;
    onMembersChange(team.id, [...team.members, created]);
    toast.success("Member added");
    return true;
  }

  async function handleSaveMember(memberId: string, data: MemberUpdate): Promise<boolean> {
    const res = await fetch(`/api/teams/${team.id}/members/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      toast.error("Failed to update member");
      return false;
    }
    const updated = await res.json() as TeamMember;
    onMembersChange(team.id, team.members.map((m) => (m.id === memberId ? updated : m)));
    toast.success("Member updated");
    return true;
  }

  async function handleDeleteMember(memberId: string) {
    const ok = await confirm({
      title: "Remove member",
      description: "Remove this member from the team? This cannot be undone.",
      confirmLabel: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch(`/api/teams/${team.id}/members/${memberId}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Failed to remove member");
      return;
    }
    onMembersChange(team.id, team.members.filter((m) => m.id !== memberId));
    toast.success("Member removed");
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = team.members.findIndex((m) => m.id === active.id);
    const newIndex = team.members.findIndex((m) => m.id === over.id);
    const reordered = arrayMove(team.members, oldIndex, newIndex).map((m, i) => ({ ...m, position: i }));
    onMembersChange(team.id, reordered);
    try {
      await fetch(`/api/teams/${team.id}/members/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: reordered.map((m) => m.id) }),
      });
    } catch {
      toast.error("Failed to save order");
    }
  }

  const editingIndex = editingMember ? team.members.findIndex((m) => m.id === editingMember.id) : -1;
  const dialogIsLast = editingMember ? editingIndex === team.members.length - 1 : true;
  const memberCount = team.members.length;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 min-w-0 flex items-start gap-2 text-left"
          aria-expanded={expanded}
        >
          {expanded
            ? <ChevronDown className="size-4 mt-0.5 text-muted-foreground shrink-0" />
            : <ChevronRight className="size-4 mt-0.5 text-muted-foreground shrink-0" />}
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-muted-foreground shrink-0" />
              <span className="font-medium truncate">{team.name}</span>
              {team.isDefault && <Badge className="text-xs">Default</Badge>}
              <span className="text-xs text-muted-foreground shrink-0">
                {memberCount} {memberCount === 1 ? "member" : "members"}
              </span>
            </div>
            {!expanded && <PipelineSummary members={team.members} />}
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={openAddMember}>
            <Plus className="size-3.5 mr-1" />
            Member
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: "ghost", size: "icon" }) + " size-7"}
              aria-label="Team actions"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onClick={() => void onSetDefault(team.id)} disabled={team.isDefault}>
                <Star className={`size-4 ${team.isDefault ? "fill-yellow-400 text-yellow-400" : ""}`} />
                {team.isDefault ? "Default team" : "Make default"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setDialogKey((k) => k + 1); setRenameOpen(true); }}>
                <Pencil className="size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(team.id)}>
                <Trash2 className="size-4" />
                Delete team
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-3 flex flex-col gap-2">
          {memberCount === 0 ? (
            <p className="text-xs text-muted-foreground">
              No members yet. Add the first stage of this pipeline.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={team.members.map((m) => m.id)} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-1.5">
                  {team.members.map((member, i) => (
                    <MemberRow
                      key={member.id}
                      member={member}
                      index={i}
                      onEdit={openEditMember}
                      onDelete={handleDeleteMember}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          <Button variant="outline" size="sm" onClick={openAddMember} className="self-start">
            <Plus className="size-3.5 mr-1.5" />
            Add member
          </Button>
        </div>
      )}

      <MemberDialog
        key={`member-${dialogKey}`}
        open={memberDialogOpen}
        onOpenChange={setMemberDialogOpen}
        member={editingMember}
        isLast={dialogIsLast}
        onSubmit={(data) => (editingMember ? handleSaveMember(editingMember.id, data) : handleAddMember(data))}
      />
      <TeamNameDialog
        key={`rename-${dialogKey}`}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename team"
        submitLabel="Save"
        initialName={team.name}
        onSubmit={(name) => onRename(team.id, name)}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState(0);
  // Teams created in this session open expanded so their first member can be added straight away.
  const [newTeamIds, setNewTeamIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetchJson<Team[]>("/api/teams")
      .then((data) => { if (!cancelled) setTeams(data); })
      .catch(() => { if (!cancelled) toast.error("Failed to load teams"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleCreateTeam(name: string): Promise<boolean> {
    const res = await fetch("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, isDefault: teams.length === 0 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      toast.error(err.error ?? "Failed to create team");
      return false;
    }
    const created = await res.json() as Team;
    const withMembers = { ...created, members: created.members ?? [] };
    setTeams((prev) => (created.isDefault ? [...prev.map((t) => ({ ...t, isDefault: false })), withMembers] : [...prev, withMembers]));
    setNewTeamIds((prev) => new Set(prev).add(created.id));
    getAnalytics()?.capture("team_created", { is_default: created.isDefault });
    toast.success("Team created");
    return true;
  }

  async function handleRename(id: string, name: string): Promise<boolean> {
    const res = await fetch(`/api/teams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      toast.error("Failed to rename team");
      return false;
    }
    setTeams((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
    return true;
  }

  async function handleSetDefault(id: string) {
    const res = await fetch(`/api/teams/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isDefault: true }),
    });
    if (!res.ok) {
      toast.error("Failed to set default team");
      return;
    }
    setTeams((prev) => prev.map((t) => ({ ...t, isDefault: t.id === id })));
  }

  async function handleDelete(id: string) {
    const ok = await confirm({
      title: "Delete team",
      description: "Delete this team? Tasks already assigned to it will fall back to running as a single agent. This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch(`/api/teams/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Failed to delete team");
      return;
    }
    setTeams((prev) => prev.filter((t) => t.id !== id));
    toast.success("Team deleted");
  }

  function handleMembersChange(teamId: string, members: TeamMember[]) {
    setTeams((prev) => prev.map((t) => (t.id === teamId ? { ...t, members } : t)));
  }

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Teams</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Pipelines of agents (e.g. Planner → Coder → Tester) that a task runs through in order instead of a single agent.
          </p>
        </div>
        <Button size="sm" onClick={() => { setCreateKey((k) => k + 1); setCreateOpen(true); }} className="shrink-0">
          <Plus className="size-4 mr-1.5" />
          New Team
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : teams.length === 0 ? (
        <Card>
          <div className="py-8 text-center text-sm text-muted-foreground">
            No teams configured yet. Click <strong>New Team</strong> to create your first pipeline.
          </div>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              defaultExpanded={newTeamIds.has(team.id)}
              onRename={handleRename}
              onSetDefault={handleSetDefault}
              onDelete={handleDelete}
              onMembersChange={handleMembersChange}
            />
          ))}
        </div>
      )}

      <TeamNameDialog
        key={`create-${createKey}`}
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New Team"
        submitLabel="Create Team"
        initialName=""
        onSubmit={handleCreateTeam}
      />
    </div>
  );
}
