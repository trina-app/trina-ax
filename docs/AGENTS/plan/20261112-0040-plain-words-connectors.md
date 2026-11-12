# Plain words left on the connector and activity screens

- Date (UTC): 2026-11-12 00:40
- Branch: `fix/plain-words-connectors`
- Status: in progress
- Where: `web/src/components/integrations/*`, `web/src/pages/admin/Audit.tsx`, `web/src/i18n/*`,
  `server/src/connectors/remote-mcp/oauth.ts`. Why: connectors and the activity log are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch, wording and one audit detail field

## Goal

QA TC-204: code names, MCP/OAuth and "token" words, and reasons that blame the person's computer.

1. Admin › Google Drive shows the tools as code chips `drive_search`, `drive_list`, `drive_read`. They now read
   "Google Drive 검색", "Google Drive 폴더 보기", "Google Drive 파일 읽기" (the step words in `FILE_STEP_VERB`,
   five languages).
2. The collapsed 고급 line of the connector dialog reads "MCP 서버 · 로그인(OAuth) · 매번 묻기" to members. Collapsed,
   it now leaves out the kind (MCP server / API), and says sign-in as "로그인". The open section keeps the exact words.
3. Gmail, Calendar, Docs and Sheets say "이 컴퓨터에서는 쓸 수 없음" when the team's server lacks them. They now say
   "이 팀 서버에서는 아직 못 써요" (and the long form), in five languages.
4. Settings › 브라우저 and the admin hint said "눈에 띄는 토큰만 걸러 내요". Already fixed on dev
   (9ee318697 "All websites: the same plain words…"; no "token" in any language). Nothing to do.
5. Admin › 활동 로그 shows "외부 앱 연결 허용 · tax_grant_<id>". The audit entries of an outside app's connection
   (connected, disconnected, admin scope dropped) now keep the app's name (`detail.app`). The row shows that name,
   and never a raw grant id. Older entries show the action alone; the id stays in the row's details.

## Scope

Kept small so open PR #399 (connectors simple page) can still rebase:
- `ConnectorsView.tsx`: one line, mono font only for a code-style name.
- `TemplatesView.tsx`: untouched.
- Locale lines far from #399's hunks, checked with `git merge-tree` against its branch.

## Steps

1. `DriveConnector.tsx`: pass the plain words; `ConnectorsView.tsx` chip font.
2. `IntegrationDialog.tsx` summary; `integrations.summary.signIn` in five languages.
3. `gapps.off.unsupported` / `unsupportedLong` in five languages.
4. `oauth.ts`: `app` in the three audit details; `Audit.tsx` `rowItem` for `remote_mcp.*`.
5. Tests:
   - `web/test/unit/activity.test.ts` (row item), `tests/unit/remote-mcp-oauth.test.ts` (detail has the app).
   - The dialog's summary and the Drive chips in web unit tests where they exist, otherwise the e2e text checks are
     updated.

## Risks

The app name is what the outside app registered (`client_name`, at most 80 characters). It is shown as text, as
Settings already does. No migration. Five languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the unit tests above, `bun run test:web`.

## Result

