import { prisma } from "./db";

// A Team is a reusable, ordered pipeline of specialized agents (e.g. Planner ->
// Coder -> Tester -> Verifier). A task with `teamId` set runs through each member
// in sequence instead of a single agent handling the whole task — see the "Team
// pipeline" section of src/worker/index.ts for the execution side.

export interface TeamMemberData {
  id: string;
  teamId: string;
  name: string;
  instructions: string;
  position: number;
  /** Pause the pipeline after this member until a human approves its output. */
  requiresApproval: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamData {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  members: TeamMemberData[];
}

// Minimal shape of the Prisma methods these helpers use — lets tests pass an
// in-memory stand-in instead of a real database (see src/lib/__tests__/teams.test.ts
// and the same pattern in src/lib/repos.ts).
export type TeamsClient = {
  team: {
    findMany: (args: unknown) => Promise<TeamData[]>;
    findUnique: (args: unknown) => Promise<TeamData | null>;
    create: (args: unknown) => Promise<TeamData>;
    update: (args: unknown) => Promise<TeamData>;
    updateMany: (args: unknown) => Promise<unknown>;
    delete: (args: unknown) => Promise<unknown>;
  };
  teamMember: {
    aggregate: (args: unknown) => Promise<{ _max: { position: number | null } }>;
    create: (args: unknown) => Promise<TeamMemberData>;
    update: (args: unknown) => Promise<TeamMemberData>;
    delete: (args: unknown) => Promise<unknown>;
  };
};

export async function listTeams(client: TeamsClient = prisma as unknown as TeamsClient): Promise<TeamData[]> {
  return client.team.findMany({
    include: { members: { orderBy: { position: "asc" } } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export async function getTeam(id: string, client: TeamsClient = prisma as unknown as TeamsClient): Promise<TeamData | null> {
  return client.team.findUnique({
    where: { id },
    include: { members: { orderBy: { position: "asc" } } },
  });
}

export async function createTeam(
  name: string,
  isDefault = false,
  client: TeamsClient = prisma as unknown as TeamsClient,
): Promise<TeamData> {
  if (isDefault) {
    await client.team.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }
  return client.team.create({
    data: { name, isDefault },
    include: { members: { orderBy: { position: "asc" } } },
  });
}

export async function updateTeam(
  id: string,
  data: { name?: string; isDefault?: boolean },
  client: TeamsClient = prisma as unknown as TeamsClient,
): Promise<TeamData> {
  // Only one team may be the default at a time — same "clear the others first"
  // pattern used for AIProvider.isDefault (see src/app/api/providers/[id]/route.ts).
  if (data.isDefault === true) {
    await client.team.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
  }
  return client.team.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
    },
    include: { members: { orderBy: { position: "asc" } } },
  });
}

export async function deleteTeam(id: string, client: TeamsClient = prisma as unknown as TeamsClient): Promise<void> {
  // Tasks referencing this team have teamId set to null via ON DELETE SET NULL
  // (see the Task.team relation) rather than being deleted themselves.
  await client.team.delete({ where: { id } });
}

export async function addTeamMember(
  teamId: string,
  data: { name: string; instructions?: string; requiresApproval?: boolean },
  client: TeamsClient = prisma as unknown as TeamsClient,
): Promise<TeamMemberData> {
  const maxPos = await client.teamMember.aggregate({
    where: { teamId },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;
  return client.teamMember.create({
    data: {
      teamId,
      name: data.name,
      instructions: data.instructions ?? "",
      requiresApproval: data.requiresApproval ?? false,
      position,
    },
  });
}

export async function updateTeamMember(
  memberId: string,
  data: { name?: string; instructions?: string; requiresApproval?: boolean },
  client: TeamsClient = prisma as unknown as TeamsClient,
): Promise<TeamMemberData> {
  return client.teamMember.update({
    where: { id: memberId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.instructions !== undefined && { instructions: data.instructions }),
      ...(data.requiresApproval !== undefined && { requiresApproval: data.requiresApproval }),
    },
  });
}

export async function deleteTeamMember(memberId: string, client: TeamsClient = prisma as unknown as TeamsClient): Promise<void> {
  await client.teamMember.delete({ where: { id: memberId } });
}

// Persist a new member order for a team — mirrors POST /api/tasks/reorder's
// "reassign position from array order" pattern.
export async function reorderTeamMembers(
  teamId: string,
  ids: string[],
  client: TeamsClient = prisma as unknown as TeamsClient,
): Promise<void> {
  await Promise.all(
    ids.map((id, index) =>
      client.teamMember.update({ where: { id, teamId }, data: { position: index } })
    )
  );
}

/**
 * `id` if a team with that id still exists, else null. Used when applying a
 * repo's saved `defaultTeamId` (Repositories page): the team may have been
 * deleted since, and a stale default should fall back to a single agent rather
 * than fail task creation on the foreign key.
 */
export async function existingTeamId(
  id: string | null | undefined,
  client: TeamsClient = prisma as unknown as TeamsClient,
): Promise<string | null> {
  if (!id) return null;
  const team = await client.team.findUnique({ where: { id }, select: { id: true } });
  return team ? id : null;
}
