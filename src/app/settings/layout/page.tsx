import { redirect } from "next/navigation";

// Layout preferences now live in the "Appearance" section of General.
export default function LayoutSettingsRedirect() {
  redirect("/settings/general#appearance");
}
