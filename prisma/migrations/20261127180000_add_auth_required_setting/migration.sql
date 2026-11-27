-- Signing in to the web UI is now optional (Settings → Security → "Require sign-in"),
-- stored as the `auth_required` Setting; a missing row means off, so fresh installs
-- open straight into the app.
--
-- Installs that were already using sign-in keep it on: anything that has ever had a
-- session, a passkey, or an account whose initial password was changed. A fresh
-- install has none of these (just the seeded owner with its initial password).
INSERT OR IGNORE INTO "Setting" ("key", "value")
SELECT 'auth_required', 'true'
WHERE EXISTS (SELECT 1 FROM "Session")
   OR EXISTS (SELECT 1 FROM "Passkey")
   OR EXISTS (SELECT 1 FROM "SignInEvent" WHERE "success" = 1)
   OR EXISTS (SELECT 1 FROM "User" WHERE "mustChangePassword" = 0);
