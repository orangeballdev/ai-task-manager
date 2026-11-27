import { connection } from "next/server";
import { integrationsServiceEnabled } from "@/lib/deployment";
import { IntegrationsServiceProvider } from "./availability";

export default async function IntegrationsLayout({ children }: { children: React.ReactNode }) {
  // The env var is set on the running deployment, not at build time.
  await connection();
  return (
    <IntegrationsServiceProvider enabled={integrationsServiceEnabled()}>
      {children}
    </IntegrationsServiceProvider>
  );
}
