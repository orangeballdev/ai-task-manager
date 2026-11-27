"use client";
import { createContext, useContext } from "react";

// Whether the integrations process (Slack bot) runs on this deployment. Provided
// by the server layout, which reads it from the environment at request time.
const IntegrationsServiceContext = createContext(true);

export function IntegrationsServiceProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <IntegrationsServiceContext value={enabled}>{children}</IntegrationsServiceContext>;
}

export function useIntegrationsServiceEnabled(): boolean {
  return useContext(IntegrationsServiceContext);
}
