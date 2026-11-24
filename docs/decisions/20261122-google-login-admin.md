# Sign in with Google is a team switch, on by default; connecting one always tells the person

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (part A2 of [the Sign in with Google plan](../AGENTS/plan/20261122-0454-google-login.md))
- Branch: feat/google-login-admin (plan [20261122-0616-google-login-admin.md](../AGENTS/plan/20261122-0616-google-login-admin.md))

- **Ask:** owners and admins need to turn Sign in with Google off and to remove a member's Google account; a person
  must learn when their account gets a new way in; Gmail and Drive should not ask again which Google account.
- **Rule (switch):** `TeamSettings.googleSignIn`, on unless an owner or admin turns it off (like the other team
  switches, not owner-only). Off: `googleLoginAvailable` answers false (no button, no connect, no start), and a Google
  return already on its way neither signs in nor connects (it reads the switch again and ends as `failed`). The
  connected accounts are kept: they sign in again when the switch is back on. The row shows only where this server has
  a Google client (`GET /api/admin/google-login`); without one it links to Connected apps › Google Drive.
- **Rule (members):** `GET /api/admin/users` lists the ids of people with a connected Google account (`google`), never
  the account or its address. `DELETE /api/admin/users/:id/google` uses the people guard of the other admin actions
  (never the owner or yourself, only the owner on admins), checked again inside the write, audited as
  `user.google_disconnected` without the address. Sessions stay: a reset (temporary password or reset link) is what
  ends them, and it disconnects Google too.
- **Rule (notice):** every new connection (not a reconnect of the same Google account) records
  `account.google_connected` for the person, shown always like `account.reset_link` (table `google_connect_notices`,
  migration 132). Its source is the connection's `linked_at`; while that same connection is there the row says what to
  do if it wasn't them and opens Settings › Security & devices.
- **Rule (login_hint):** with a connected Google account, the direct-mode Google address of the person's own Google
  Drive and own Gmail, Calendar, Docs and Sheets carries `login_hint=<the address Google gave at the last sign-in>`.
  Not for a Drive or app account shared with the team (often another account), not in broker mode (the hosting service
  builds that address; passing a hint would change the broker contract).
- **Why:** on by default because it only works for people who connected it themselves with their password; a switch
  for teams that want passwords only. Kept connections, so turning it off for a day does not make everyone connect
  again. The notice is defense in depth: someone with the password could connect their own Google account.
- **Left out:** a notice when an admin disconnects someone's Google account; ending sessions on disconnect; Google
  Workspace suspension (the docs say to disable the person in Trina AX).
- **Version impact:** minor (a team setting, two endpoints, an add-only migration, a new Inbox notice).
