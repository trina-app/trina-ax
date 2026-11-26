# Google sign-in asks for the minimum scopes: no narrower scope beside the broader one that includes it

- Date: 2026-11-25
- Status: accepted
- Supersedes: none
- Branch: fix/google-scopes-minimum (plan: docs/AGENTS/plan/20261125-0833-google-scopes-minimum.md)

- **Ask (owner, 2026-11-25):** Google's verification review of the hosting service's OAuth client (project
  trina-ax-513907) checks for "minimum scopes". Drop the overlapping narrower scopes, in code and in the console's
  Data Access list, and keep the two equal.
- **Rule:** the sets are `GOOGLE_APP_BROKER_SCOPES` and `DRIVE_BROKER_SCOPE` (shared cloud-protocol, MIT); their union
  `GOOGLE_CONSOLE_SCOPES` is exactly the console list: `openid`, `userinfo.email`, `userinfo.profile`,
  `drive.readonly`, `drive.file`, `gmail.modify`, `gmail.settings.basic`, `calendar`, `documents`, `spreadsheets`.
  Dropped: `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.labels` (Google's API reference accepts
  `gmail.modify` for every such method), `calendar.readonly`, `calendar.events` (`calendar`), `documents.readonly`
  (`documents`), `spreadsheets.readonly` (`spreadsheets`). Kept `gmail.settings.basic` (filters and vacation replies
  accept only it or full mail access) and both Drive scopes (no broader one is used: full `drive` is restricted and
  broader than we need).
- **One check:** `googleScopesCover` moves to the contract, so the team server and the control plane test a grant
  the same way; its table gains `gmail.send`, `gmail.compose`, `gmail.labels` → `gmail.modify`.
- **Existing connections:** a grant made before this holds the old, larger set, a superset of the new one, so the
  sign-in and refresh checks still pass and nobody reconnects. The Google Workspace MCP library (2.4.1) checks each
  tool's scope with its own hierarchy (`SCOPE_HIERARCHY`), which already treats the broader scopes as covering the
  narrower ones its tools declare.
- **Control plane:** trina-cloud vendors the contract (`scripts/sync-protocol.ts`): sync it and replace its own copy
  of the coverage check with `googleScopesCover` so its broker asks Google for the same smaller set.
- **Version impact:** patch (fewer scopes on Google's consent screen; nothing else changes).
- **Rollout:** team servers older than this release check the hosting service's Google grant against an old table,
  which knows only that `gmail.modify` covers `gmail.readonly`. When trina-cloud asks Google for only the 10 scopes,
  Gmail sign-in on those servers would fail with `scope_denied`, unless trina-cloud adds the implied narrower scopes
  to the granted-scope list it hands back: `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.labels`, also
  `calendar.readonly`, `calendar.events`, `documents.readonly`, `spreadsheets.readonly`. Order: that trina-cloud
  change ships first, then the console edit. The console must never list fewer scopes than the hosting service
  requests.
