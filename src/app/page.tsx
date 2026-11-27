import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const homePageSetting = await prisma.setting.findUnique({ where: { key: "home_page" } });
  const value = homePageSetting?.value;
  redirect(!value || value === "/" ? "/tasks" : value);
}
