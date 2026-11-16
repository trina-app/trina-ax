# A team file attached to something a connected service sends (a mail)

- Date (UTC): 2026-11-16
- Branch: `feat/mail-attach-team-file`
- Status: in progress
- Where: server/src/integrations/connections (the connection tools of Team AX core). Why: connections, their write
  card and the file permissions are core (docs/REPOSITORY-RULES.md), and the gap is in the core's MCP tool path.
- Version impact: minor: the AI can do something new (attach a team file); no setting, no migration.

## Goal

"이 견적서 김대리한테 메일로 보내줘" sends the mail with the file attached, after the one mail card that is there today.
Found in the AI scenario flow FL-08: the AI stopped at a draft without the file.

## Cause

A connection's MCP tool is called with the AI's own arguments only (connections/tools.ts mcpTool). A mail tool takes a
file as base64 text in an argument. The AI cannot write a team file's base64: `read` gives it text or a picture, never
bytes, and a write over 100,000 characters is refused before the card (MAX_CARD_PAYLOAD). Gmail's send and draft also
refuse an attachment given by path or web address (the library would read this server's disk). So no path carried a
team file's bytes to a connected service.

## Scope

In: a handle the AI puts where the tool wants the file's content, `team-file:<team path>`; the server puts the file's
base64 there after the card. MCP tools of connections (also through call_tool), Gmail's send and draft included.
Out: `api_request` (1 MiB body, no base64 convention), scheduled runs, base64url or multipart forms, attaching a room
or chat file that is not in the team folder.

## Steps

1. `connections/team-attach.ts`: find the handles, read each file as the person (read permission, regular file, safety
   list), the cap, the card lines, the swap.
2. `connections/tools.ts` mcpTool: refuse where nobody answers a card or the tool is a read; show the files on the
   card; check again after the card; send; audit line; read scope.
3. The AI's instructions ("Connected services") and Gmail's two sending tools say how.
4. Card words in six languages (connections/text.ts); docs/INTEGRATIONS.md, docs/GOOGLE-APPS.md.
5. Unit tests: tests/unit/c-integrations-attach.test.ts.

## Decisions

docs/decisions/20261116-mail-attach-team-file.md

## Result

(filled in at the end)
