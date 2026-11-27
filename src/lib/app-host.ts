// Defaults shared by the server (notification links, Slack) and the settings pages.
// Kept free of server-only imports so client components can use it.

/** Where notification links point when Settings → Admin → App Host is unset. */
export const DEFAULT_APP_HOST = "localhost:3000";

/** Setting row holding the address notification emails are sent from (must be verified in Amazon SES). */
export const NOTIFICATION_FROM_SETTING = "notification_from_address";
