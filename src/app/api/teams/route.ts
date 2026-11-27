import { NextRequest, NextResponse } from "next/server";
import { listTeams, createTeam } from "@/lib/teams";

export async function GET() {
  const teams = await listTeams();
  return NextResponse.json(teams);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { name?: string; isDefault?: boolean };
  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const team = await createTeam(name, Boolean(body.isDefault));
  return NextResponse.json(team, { status: 201 });
}
