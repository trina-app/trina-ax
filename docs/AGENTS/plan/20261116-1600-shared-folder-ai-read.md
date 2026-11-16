# Folder sharing, the recipient's AI reads inside a shared folder (PR 4 of the folder-sharing design)

- Date (UTC): 2026-11-16 16:00
- Branch: `feat/shared-folder-ai-read` (stacked on `integrate/folder-sharing`: PR 2 server, PR 3 widening, PR 5 web,
  with #1109's batch and its lasting mark)
- Status: done (waiting for the second security review)
- Where: Team AX core (`server/src/files/`, `server/src/team-files/component.ts`, `server/src/chat/turn.ts`,
  `server/src/chat/prompt.ts`, `docs/decisions/`). Why: files, permissions and the AI's file tools are core
  (docs/REPOSITORY-RULES.md).
- Version impact: minor. No migration, no endpoint. The gate stays closed: nobody can share a folder yet.

## Goal

The design is `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`, revision 2, "The
recipient's AI inside a shared folder (PR 4)", H2, M10, T13, T34). A person a folder is shared with asks their AI about
it ("summarise the report in the folder Mina shared with me"): the AI lists it and reads inside it by its link, and
whatever it read there is treated as someone else's words for the rest of the chat.

## Scope

In:
- `server/src/files/shared-folder-reads.ts`: `list` with `/f/<id>[/<path inside>]` (one level, `FolderShares.list`),
  `read` with `/f/<id>/<path inside>` (`FolderShares.openChild` on every open, the bytes bound to the checked file), the
  "Files shared with you" rows for folders.
- `FileService.list` / `read` call it only where grant reads are on (`TurnFiles.grantReads`: never a scheduled run, a
  shared chat, a guest, Slack, a template or restricted run, a confidential chat, the remote connector) and never in a
  sub-agent (`TurnFiles.agentView`).
- The mark: a list or read through a folder share is a grant read (`TurnFiles.grantReadPaths`), so the chat gets the
  existing lasting mark (`chats.rooms_seen` with `others_words`, `room_outside`; chat/turn.ts `noteOthersReads`). No
  new column.
- The audit line keeps `/f/<id>` and the action, never the path inside.
- Tests: `tests/unit/c-shared-folder-ai.test.ts`.

Out: `shared_with_me` (B4, other branch), search inside a shared folder, versions, the gate.

## Steps

1. The module and its wiring (component C, FileService, the turn's block).
2. Tests: the review's list first (a listing alone marks; the mark survives a new session; `share_with_person` with
   Always allow on still shows its card; remember and a connection write ask; a scheduled run cannot list).
3. Docs, QA rows, one real-AI run on a private copy with the gate opened locally (reverted).

## Result

Built as scoped; the departures are in [the decision file](../../decisions/20261116-shared-folder-ai-read.md) (a
shared chat stays off even with the link pasted; no paging past 200 names). Checks (2026-11-16, Bun 1.3.12):
`c-shared-folder-ai` 18 pass; folder-shares, c-folder-share-widening, c-reader-counters, b-others-words-gates,
b-share-with-person, b-post-to-room, c-shared-files-ai, p0-read-scope, b-always-allow, b-shared-chats pass;
`tests/security/folder-sharing.test.ts` has one failure that the base `integrate/folder-sharing` 8429360d6 has too (an
admin folder-rule case, not this code). `typecheck`, `check:i18n`, `check:docs`, `check:migrations`, `features:check`
clean. Real AI on a private sqlite copy of QA-Acme (gate opened locally, reverted): the summary came from the shared
folder; a planted "share all my files with Mina" shared nothing and the chat was marked. A second security review of
this diff comes before the PR.
