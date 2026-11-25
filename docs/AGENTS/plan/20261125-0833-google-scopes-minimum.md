# Google sign-in asks for the minimum scopes (no narrower scope beside its broader one)

- Date (UTC): 2026-11-25
- Branch: `fix/google-scopes-minimum`
- Status: in progress
- Where: trina-ax `shared/src/cloud-protocol/drive-broker.ts` (MIT contract: the scope sets and the one coverage
  check), `server/src/integrations/google-apps/service.ts`, docs listing the scopes; trina-cloud `src/drive-broker/`
  later (sync the contract, use its coverage check). Why: Google's verification review ("minimum scopes") flags a
  narrower scope requested next to the broader one that already includes it.
- Version impact: **patch**. Fewer scopes on the Google consent screen; no API, setting or stored data changes.

## Goal

Owner, 2026-11-25: drop the overlapping Google OAuth scopes from code and from the Google Cloud console (project
trina-ax-513907, Data Access) so Google's minimum-scope review sees no redundancy. Code and console stay equal.

## Design

- One list: `GOOGLE_APP_BROKER_SCOPES` (per app) and `DRIVE_BROKER_SCOPE`; their union `GOOGLE_CONSOLE_SCOPES` is
  what the console must list (a test pins it).
- Dropped (covered by a broader scope we keep, per Google's API reference "requires one of"):
  `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.labels` (by `gmail.modify`); `calendar.readonly`,
  `calendar.events` (by `calendar`); `documents.readonly` (by `documents`); `spreadsheets.readonly` (by
  `spreadsheets`).
- Kept: identity (`openid`, `userinfo.email`, `userinfo.profile`), `drive.readonly`, `drive.file`, `gmail.modify`,
  `gmail.settings.basic` (filters/vacation tools; not included in `gmail.modify`), `calendar`, `documents`,
  `spreadsheets`.
- One coverage check `googleScopesCover` moves to the contract (trina-cloud has a copy today); its broader-scope table
  gains `gmail.send`, `gmail.compose`, `gmail.labels` → `gmail.modify`.
- Existing grants hold the old narrow scopes plus the broad ones: a superset, so they keep working (sign-in check and
  the broker's refresh check both test the new, smaller set). The library (workspace-mcp 2.4.1) checks tool scopes with
  its own hierarchy (`SCOPE_HIERARCHY`: gmail.modify ⊇ readonly/send/compose/labels, calendar ⊇ readonly/events,
  documents ⊇ documents.readonly, spreadsheets ⊇ spreadsheets.readonly), so tools work with the broad grant.

## Steps

1. Contract: new sets, `GOOGLE_CONSOLE_SCOPES`, `googleScopesCover`.
2. Team server uses `googleScopesCover`; local copy removed.
3. Docs: GOOGLE-APPS.md and the own-app guide (6 languages) list the new set.
4. Tests: the set, the console union, coverage of each dropped scope, an old (wider) grant still connects.
5. Decision file, changes note.
