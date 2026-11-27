import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  deleteTeamMember,
  existingTeamId,
  getTeam,
  listTeams,
  reorderTeamMembers,
  updateTeam,
  updateTeamMember,
  type TeamData,
  type TeamMemberData,
  type TeamsClient,
} from "../teams";

// In-memory stand-in for the Prisma `team`/`teamMember` models so these tests don't
// need a real database. Mirrors the minimal shape TeamsClient expects (same pattern
// as fakeClient() in repos.test.ts).
function fakeClient(): TeamsClient {
  let teamSeq = 0;
  let memberSeq = 0;
  const teams: TeamData[] = [];

  const findTeam = (id: string) => teams.find((t) => t.id === id);
  const sortedMembers = (members: TeamMemberData[]) => [...members].sort((a, b) => a.position - b.position);

  return {
    team: {
      findMany: async () => {
        return [...teams]
          .sort((a, b) => {
            if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
            return a.createdAt.getTime() - b.createdAt.getTime();
          })
          .map((t) => ({ ...t, members: sortedMembers(t.members) }));
      },
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        const t = findTeam(where.id);
        return t ? { ...t, members: sortedMembers(t.members) } : null;
      },
      create: async (args: unknown) => {
        const { data } = args as { data: { name: string; isDefault: boolean } };
        const now = new Date(Date.now() + teamSeq);
        const t: TeamData = { id: `team-${++teamSeq}`, name: data.name, isDefault: !!data.isDefault, createdAt: now, updatedAt: now, members: [] };
        teams.push(t);
        return { ...t, members: [] };
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: { name?: string; isDefault?: boolean } };
        const t = findTeam(where.id);
        if (!t) throw new Error("team not found");
        if (data.name !== undefined) t.name = data.name;
        if (data.isDefault !== undefined) t.isDefault = data.isDefault;
        t.updatedAt = new Date();
        return { ...t, members: sortedMembers(t.members) };
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as { where: { isDefault?: boolean; id?: { not: string } }; data: { isDefault?: boolean } };
        for (const t of teams) {
          if (where.isDefault !== undefined && t.isDefault !== where.isDefault) continue;
          if (where.id?.not && t.id === where.id.not) continue;
          if (data.isDefault !== undefined) t.isDefault = data.isDefault;
        }
        return { count: teams.length };
      },
      delete: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        const idx = teams.findIndex((t) => t.id === where.id);
        if (idx >= 0) teams.splice(idx, 1);
        return {};
      },
    },
    teamMember: {
      aggregate: async (args: unknown) => {
        const { where } = args as { where: { teamId: string } };
        const t = findTeam(where.teamId);
        const positions = (t?.members ?? []).map((m) => m.position);
        return { _max: { position: positions.length ? Math.max(...positions) : null } };
      },
      create: async (args: unknown) => {
        const { data } = args as { data: { teamId: string; name: string; instructions: string; position: number; requiresApproval?: boolean } };
        const t = findTeam(data.teamId);
        if (!t) throw new Error("team not found");
        const now = new Date();
        const m: TeamMemberData = {
          id: `member-${++memberSeq}`,
          teamId: data.teamId,
          name: data.name,
          instructions: data.instructions,
          position: data.position,
          requiresApproval: data.requiresApproval ?? false,
          createdAt: now,
          updatedAt: now,
        };
        t.members.push(m);
        return { ...m };
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string; teamId?: string }; data: Partial<TeamMemberData> };
        for (const t of teams) {
          const m = t.members.find((m) => m.id === where.id);
          if (m) {
            Object.assign(m, data);
            m.updatedAt = new Date();
            return { ...m };
          }
        }
        throw new Error("member not found");
      },
      delete: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        for (const t of teams) {
          const idx = t.members.findIndex((m) => m.id === where.id);
          if (idx >= 0) {
            t.members.splice(idx, 1);
            return {};
          }
        }
        return {};
      },
    },
  };
}

test("createTeam with isDefault clears any previously-default team", async () => {
  const client = fakeClient();
  const first = await createTeam("Alpha", true, client);
  assert.equal(first.isDefault, true);

  const second = await createTeam("Beta", true, client);
  assert.equal(second.isDefault, true);

  const all = await listTeams(client);
  const alpha = all.find((t) => t.name === "Alpha");
  assert.equal(alpha?.isDefault, false, "Alpha should no longer be default once Beta is created as default");
});

test("updateTeam(isDefault: true) clears the default flag on other teams", async () => {
  const client = fakeClient();
  const a = await createTeam("A", true, client);
  const b = await createTeam("B", false, client);

  await updateTeam(b.id, { isDefault: true }, client);

  const all = await listTeams(client);
  assert.equal(all.find((t) => t.id === a.id)?.isDefault, false);
  assert.equal(all.find((t) => t.id === b.id)?.isDefault, true);
});

test("addTeamMember assigns incrementing positions in the order members are added", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);

  const m1 = await addTeamMember(team.id, { name: "Planner", instructions: "Plan it" }, client);
  const m2 = await addTeamMember(team.id, { name: "Coder", instructions: "Code it" }, client);
  const m3 = await addTeamMember(team.id, { name: "Tester", instructions: "Test it" }, client);

  assert.equal(m1.position, 0);
  assert.equal(m2.position, 1);
  assert.equal(m3.position, 2);

  const loaded = await getTeam(team.id, client);
  assert.deepEqual(loaded?.members.map((m) => m.name), ["Planner", "Coder", "Tester"]);
});

test("reorderTeamMembers persists the new order immediately", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);
  const m1 = await addTeamMember(team.id, { name: "Planner" }, client);
  const m2 = await addTeamMember(team.id, { name: "Coder" }, client);
  const m3 = await addTeamMember(team.id, { name: "Tester" }, client);

  // Move Tester to the front.
  await reorderTeamMembers(team.id, [m3.id, m1.id, m2.id], client);

  const loaded = await getTeam(team.id, client);
  assert.deepEqual(loaded?.members.map((m) => m.name), ["Tester", "Planner", "Coder"]);
});

test("updateTeamMember edits a member's role/instructions in place", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);
  const m1 = await addTeamMember(team.id, { name: "Coder", instructions: "old" }, client);

  const updated = await updateTeamMember(m1.id, { instructions: "new instructions" }, client);
  assert.equal(updated.name, "Coder");
  assert.equal(updated.instructions, "new instructions");
});

test("members default to no approval gate, and the gate can be set on add and toggled on update", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);
  const planner = await addTeamMember(team.id, { name: "Planner", requiresApproval: true }, client);
  const coder = await addTeamMember(team.id, { name: "Coder" }, client);
  assert.equal(planner.requiresApproval, true);
  assert.equal(coder.requiresApproval, false);

  const toggled = await updateTeamMember(planner.id, { requiresApproval: false }, client);
  assert.equal(toggled.requiresApproval, false);
  assert.equal(toggled.name, "Planner");
  // Editing other fields leaves the gate alone.
  const renamed = await updateTeamMember(coder.id, { name: "Builder" }, client);
  assert.equal(renamed.requiresApproval, false);
});

test("deleteTeamMember removes only the targeted member", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);
  const m1 = await addTeamMember(team.id, { name: "Planner" }, client);
  const m2 = await addTeamMember(team.id, { name: "Coder" }, client);

  await deleteTeamMember(m1.id, client);

  const loaded = await getTeam(team.id, client);
  assert.deepEqual(loaded?.members.map((m) => m.id), [m2.id]);
});

test("deleteTeam removes the team", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);
  await deleteTeam(team.id, client);
  const loaded = await getTeam(team.id, client);
  assert.equal(loaded, null);
});

test("existingTeamId keeps a live team id and drops a deleted or empty one", async () => {
  const client = fakeClient();
  const team = await createTeam("Pipeline", false, client);
  assert.equal(await existingTeamId(team.id, client), team.id);
  assert.equal(await existingTeamId("team-missing", client), null);
  assert.equal(await existingTeamId(undefined, client), null);
  assert.equal(await existingTeamId("", client), null);
  await deleteTeam(team.id, client);
  assert.equal(await existingTeamId(team.id, client), null);
});
