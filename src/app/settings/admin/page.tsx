import { redirect } from "next/navigation";

// App Host now lives in the "Server" section of General.
export default function AdminSettingsRedirect() {
  redirect("/settings/general#app-host");
}
