// Facts about how this deployment is run, set by whoever deploys it (e.g. the
// Helm chart) through env vars on the app process. Read at request time.

/**
 * Whether the integrations process (the Slack bot and its notifications) runs
 * alongside the app. The Helm chart sets INTEGRATIONS_SERVICE_ENABLED=false
 * when `integrations.enabled` is off; unset means it runs, as in
 * docker-compose and `npm run dev`. Inbound email is served by the app itself
 * and isn't affected.
 */
export function integrationsServiceEnabled(): boolean {
  return process.env.INTEGRATIONS_SERVICE_ENABLED !== "false";
}

export const INTEGRATIONS_OFF_MESSAGE =
  "Integrations are turned off on this deployment, so the Slack bot can't run here. " +
  "Ask whoever runs this deployment to enable the integrations service.";
