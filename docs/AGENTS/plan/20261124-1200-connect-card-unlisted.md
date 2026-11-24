# The chat's connect card: "not in the app's list" in the owner's words

- Date (UTC): 2026-11-24 12:00
- Branch: `feat/connect-card-unlisted`
- Status: done
- Where: trina-ax `web/src` (the chat's connect card and its words) and the docs that describe it. Why: the card is
  shared chat code, not edition code (docs/REPOSITORY-RULES.md).
- Version impact: patch: the same warning on the same card, in the owner's words; no API, no migration.

## Goal

Owner decision 2026-11-24: when the AI fills in a connection whose address is not a listed service's official address,
the card warns and the person can still connect. The card already does this (`web/src/lib/connectCard.ts` `cardTrust`
kind `unlisted`, the `connect-unlisted` box with the host in bold, docs/DECISIONS.md "The chat's connect card trusts the
app's list"), but its words ("This app does not know this address, so it cannot check it. Connect only if you know and
trust it.") do not say what to check. The owner's line says it: "트리나 앱 목록에 없는 주소예요. 이 서비스의 공식
문서에 나온 주소와 같은지 확인해 주세요."

## Scope

In:
- Reuse the existing `connect-unlisted` box (no second line): `connect.unlisted` gets the owner's words in all six app
  languages (ko as given; en, ja, zh, es, id in each file's tone, as short). The host stays in bold before it.
- When it shows, unchanged: any address that is not exactly a listed service's official address (https, host and path,
  `officialService`, which covers a service's other official addresses such as Canva's api.canva.com or Atlassian's v1),
  and not an admin's template or a reconnect of the person's own connection. A listed name at another address keeps
  its more exact line instead (`connect-not-official`: "This is not Notion's official address …").
- Tests: shows for an unknown MCP server and an unknown HTTP API; not for a listed official address, a listed
  service's other official address, an admin's template, a reconnect. The Korean words are pinned.
- Docs: docs/INTEGRATIONS.md "Connecting from a chat", docs/ASKS.md `conn.connect.service`, docs/CONNECTIONS.md (the
  by-address row gains the chat card), the docs site's "Connect from a chat" in six languages, a decision file, a
  `changes/` note.

Out: the "not {name}'s official address" line's words; the server (it already sends the card unchanged); the Settings
dialogs.

## Steps

1. This plan.
2. `connect.unlisted` in `web/src/i18n/{ko,en,ja,zh,es,id}.ts`; the card's comment.
3. `web/test/unit/connect-card.test.tsx`: the cases above.
4. Docs, decision, `changes/connect-card-unlisted.md`.
5. `bun run typecheck`, `bun run check:i18n`, the web unit tests, `bun run check:prepush`, `bun run check:docs`.

## Decisions

`docs/decisions/20261124-connect-card-unlisted.md` (the owner's line; when it shows). Builds on docs/DECISIONS.md
"The chat's connect card trusts the app's list".

## Risks

None for data or permissions: words only. Six app languages: each file's tone (Indonesian "Anda" not needed here, the
line has no "you"). Phone and desktop use the same web card.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`,
`bun test web/test/unit/connect-card.test.tsx` (web's runner).

## Result

Built as planned in https://github.com/trina-app/trina-ax/pull/527. The existing `connect-unlisted` box carries the
owner's line in six languages (no new line, no new key); the card's comments say when it shows. Tests in
`web/test/unit/connect-card.test.tsx` cover an unknown MCP server (key and sign-in), an HTTP API with a header key and a
listed host at another path (the line, the host in bold, Connect stays), and a listed official address, three other
official addresses (Canva, Atlassian v1, Netlify), templates and reconnect cards (no line). Docs as in Scope.
