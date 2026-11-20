# Settings › Export: every member downloads a ZIP of their own chats

- Date (UTC): 2026-11-20 02:51
- Branch: `ap038-export-my-chats`
- Status: done
- Where: trina-ax server, shared contract, web. Why: the AI parity QA (AP-038) found that claude.ai lets every user
  export their data, and in Trina only the owner has an export (Admin › System).
- Version impact: minor. A new endpoint pair and a new Settings section; nothing removed or changed.

## Goal

A member opens Settings › Export, presses one button and gets a ZIP of their own AI chats: one Markdown file and one
JSON file per chat. Attachments are links back to Trina, not copies.

## Scope

In:
- `POST /api/me/export` (members, not guests): starts a job that writes the ZIP server-side, outside the team folder.
- `GET /api/me/export/:jobId/download`: only the person who made it; kept 24 hours, the next export replaces it.
- Only the person's own chats (`chats.user_id`), with the rules of the owner's export: a shared project chat only while
  they still see its project, answers withheld from them as one line, stored secrets hidden in titles, file names,
  headings and the JSON.
- One export at a time per person; an audit row `export.mine`.
- Web: a new Settings section "Export", i18n keys in all locales.

Out:
- The owner's full export (Admin › System) stays as it is.
- Memories and files (the person can download their files in Files already). Phone app UI.

## Steps

1. Take the chat selection out of `runExport` into one generator both exports use.
2. `server/src/system/my-export.ts`: the ZIP (zip-out.ts), names with `safeSegment`, links for attachments.
3. Contract in `shared/src/api/system.ts`, routes in `server/src/routes/system.ts`, file sweep.
4. Web section, i18n, activity label.
5. Decision file, changes file, tests.

## Decisions

`docs/decisions/20261120-export-my-chats.md`. It keeps the redaction rule of the settings export
(docs/DECISIONS.md, QA SEC-16).

## Risks

- Privacy: never another person's chat. Tests check it.
- No migration: the job uses kind `export` (the `jobs.kind` CHECK has no other free value), so member exports wait in
  the one export line of the server.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, server unit tests for my-export and the routes, one
web unit test.

## Result

Built as planned: `server/src/system/my-export.ts`, `ownChats` in `server/src/system/export.ts` (one chat selection for
both exports), `POST /api/me/export` and `GET /api/me/export/:jobId/download` in `server/src/routes/system.ts`, the
Settings section `web/src/components/settings/MyExport.tsx`. Also: a permission matrix case for each route, the feature
`settings.export` in docs/features.ts with its AI scenario line and case SET-03, the regenerated HTTP API page.
Differences: guests do not get it (the guest endpoint list is deny by default); the decision is a file in
docs/decisions/, not a section in docs/DECISIONS.md (the archive; check:docs refuses new lines there).
