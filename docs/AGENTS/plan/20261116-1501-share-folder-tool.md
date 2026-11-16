# The AI shares a folder in the person's own files: `share_folder` (PR 6 of the folder-sharing design)

- Date (UTC): 2026-11-16 15:01
- Branch: `feat/share-folder-tool` (from `integrate/folder-sharing`, with `integrate/ai-sharing` merged in)
- Status: in progress
- Where: Team AX core (`server/src/chat/`, `server/src/files/folder-shares.ts`, `shared/src/tools.ts`,
  `shared/src/api/share-card.ts`, `web/src/components/chat/ShareCard.tsx`, `web/src/lib/shareCard.ts`, `web/src/i18n/*`,
  `docs/decisions/`). Why: files, permissions, sharing and the AI's tools are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new AI tool, offered only once folder sharing's gate is open (closed in code). No migration:
  the server undo (migration 360's `file_share_undos`) exists already.

## Goal

The design is `docs/AGENTS/plan/20261116-1147-folder-sharing.md` (branch `plan/folder-sharing`), section "`share_folder`
(a person's own folder; PR 6)", with the security review's M6, M7 and M9. A person asks "share the folder QA-test with
qa-b" (QA "Manual AI tests" MAN-019) and the AI does it, as the Share dialog does, through one card that turns into the
result in place; "stop sharing QA-test with qa-b" takes it back, with Undo.

## Scope

In:
- `share_folder` (`ShareFolderInput`: `folder`, `add`, `remove`, `stop`), a tool of its own, separate from
  `share_with_person`. An add **always** shows its card: no Always allow kind, no explicit-ask skip. A removal or stop
  narrows access: no card when the asker's own message names the folder (and, for a removal, every person); otherwise
  the card. Undo is the server's (`POST /api/files/shares/undo`, the snapshot of migration 360): still-valid grants,
  quietly, for the actor only, once.
- `namesFolder` (M9): a folder is named only by its path, its place in words, a quoted name, or the app's own file
  mention; "Work" or "Reports" in a sentence do not count. A target that came only from `looking_at` never counts.
- Off (refused, not offered): scheduled runs, confidential chats, Slack, restricted and template runs, sub-agents, guest
  turns, the gate closed. In a chat with other people's words (a shared chat, one others wrote in, a room or shared-file
  read, content someone else wrote) only when the asker's own message names the folder and, for an add, every person.
- Never-shared places, a disk without birth times, a team folder and `run_active` refused with one plain sentence and a
  next step; nothing about another person's folder.
- The record: the same card and `Step.shared` as `share_with_person` / `stop_sharing`, with a folder row (name, place in
  words, what it holds, "including what you add later"), `undo` for a removal, `keptOwn` for a stop. Only the actor ever
  gets it (M7, `ChatStore.viewSteps`; tested for a chat shared later).
- Audit `via: 'ai'` (FolderShares.change).
- Words: with the gate open the AI is told to use `share_folder` for the person's own folders; with it closed B1's
  interim "I can't share the whole folder yet, but I can share the N files in it" stays.
- Web: the share card shows a folder row and calls the server's Undo when the record has one. Six languages.

Out: team folders by the AI (`change_folder_access`, PR 7), the recipient's AI inside a shared folder (PR 4), opening
the gate.

## Steps

1. Shared: `ShareFolderInput`, step label, `ShareCardFile.folder`, `StepShared.undo` / `keptOwn`.
2. Server: `chat/share-folder.ts` (the tool, `shareFolderOff`, `namesFolder` in `shared-actions.ts`), registration and
   the tool lists (parent-only, shared-chat, own-words, rooms-seen), `viewSteps`, `sharedSources`; folder view
   `canStop` for its owner; words in `share-words.ts` and `prompt.ts` keyed on the tool being offered.
3. Web: `ShareCard` folder row, server Undo; i18n.
4. Tests: `tests/unit/b-share-folder.test.ts` (every rule above), web unit for the card, Playwright share-card spec.
5. Real AI once on a private QA copy with the gate opened locally (reverted), screenshots 1440/390 light/dark.

## Decisions

`docs/decisions/20261116-share-folder-tool.md`: the tool, its card rule, `namesFolder`, where it is off.

## Risks

Shared files with the AI-sharing builders (`shared-actions.ts`, `share-words.ts`, `prompt.ts`, `tools.ts`, the tool
lists): small additive edits. The gate stays closed, so nothing changes for anyone until it opens.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `check:migrations`, `features:check`; under Bun 1.3.12 the new test,
folder-shares security, c-folder-share-widening, b-stop-sharing, b-share-with-person, b-others-words-gates,
b-always-allow, explicit-ask; web unit; Playwright share-card / step-fix specs.

## Result

(filled in at the end)
