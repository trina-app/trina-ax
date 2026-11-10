# One rule for "this chat has read rooms": a side chat and a quote count

- Date (UTC): 2026-11-10 07:12
- Branch: `fix/side-chat-counts-as-room-read`
- Status: done
- Where: trina-ax `server/src/chat/`. Why: the room-read rule is Team AX core chat permissions (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch. A security consistency fix; no API, data or migration change.

## Goal

The person's own chat counts as "has read rooms" (other people's words came in) only when a room tool ran
(`chats.rooms_seen`). In a ✦ side chat, "Ask Trina about this" puts another person's message, up to 4,000 characters,
into the person's own message as a `>` quote, and no room tool has to run. Planted words in that quote could then reach
`delete_files`, a skill folder through `skill_files`, or a change without the room card, with none of the "read
rooms" rules applied.

PR #310 (`change_project_members`, not merged) already treats "has read rooms" as `rooms_seen`, a side chat
(`chats.side_room_id`) or a `>` quote in the person's messages on the branch. This change makes that one shared rule
and uses it wherever the person's own chat gates on "other people's words came in".

## Scope

In:

- One helper, `server/src/chat/read-rooms.ts` `readRooms(exec)`: `rooms_seen`, or a side chat, or a line starting
  with `>` in a user message on this answer's branch (the same test as #310).
- Used in: `delete_files`'s refusal, `skill_files`'s S7 (nothing into a skill folder after a room read, both checks),
  the room card in the person's own chat (`confirmRoomChange`) and the tools whose own card stands in for it
  (`ownCard`), `remember`'s confirm, and the turn's outside mark (files the turn writes carry level 2).
- Left on `rooms_seen` on purpose, with the reason in the PR: the audit's hidden sub-agent descriptions and URLs
  (what admins read, not a gate), "대화방에 보내기"'s audience check (who can see an answer's material), and
  `post_to_room`'s card line (that card is asked every time; wording only).
- The refusal texts say "or quotes another person's message" where they named only team chat rooms.

Out: a migration or a stored mark for quotes (the branch is read when it is needed), any UI change, #310 itself (it
switches to the helper when it lands; the PR body says so).

## Steps

1. The helper and its test.
2. Switch each site; keep the narrow `Pick<TurnExec, ...>` types, so the existing fakes still work.
3. Tests: a side chat with a quote is refused for `delete_files` and cannot put anything into a skill folder; a plain
   own chat with no quote still works; the helper's three ways in and an edited branch without the quote.
4. CHANGELOG line under `## Unreleased`.

## Risks

- More cards: an own chat with a `>` line on its branch (a pasted email too) now gets the room card before team
  changes, as after a room read; a side chat gets it before the AI read its room. A new file in the person's own
  folder still needs none. A scheduled task whose prompt quotes with `>` is treated like one that read a room.
- Cost: the branch walk (at most 2000 messages up, only user messages with a `>` read) runs per check; no new index.
- No migration; no API change; the five app languages are unchanged (the server's English refusal texts change).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run build:native`, then `ai-delete-files`, `skill-files`,
`b-side-chat`, `b-chat-rooms*`, `b-post-to-room` and `tests/security/permission-matrix.test.ts`.

## Result

As planned. `server/src/chat/read-rooms.ts` `readRooms(exec)` (`rooms_seen`, then `side_room_id`, then a `>` line in a
user message on the branch; the side chat and quote part kept per turn in a WeakMap, `rooms_seen` read each time). Used
in `delete-files.ts` (refusal), `skill-files.ts` (S7, both checks, one reason text), `turn.ts` (`confirmRoomChange`,
whose read-only set is now checked first; `ownCard`; `syncOutsideMark`) and `tools.ts` (`remember`). Through `ownCard`
these follow too, unchanged: `TurnPerson.roomsSeen` for moves, connections and the URL gate, and the room line on the
`connect_service` and `move_skill` cards. Left on `rooms_seen`: the audit's hidden descriptions and URLs,
`answer-share.ts`, `post-to-room.ts`'s card line. DECISIONS.md entry and CHANGELOG line added.

Checks: `bun run typecheck`, `bun run check:i18n` (0 issues), `bun run check:docs`, `bun run build:native`.
`b-side-chat` 5 pass, `ai-delete-files` 32 pass, `skill-files` 42 pass, `b-chat-rooms` 35, `b-chat-rooms-save` 9,
`b-chat-rooms-fewer-cards` 24, `b-post-to-room` 20, `b-rooms-ai-shared-chats` 16, `b-rooms-ai-threads` 17,
`b-chat-titles` 20, `c-slack` 63, `room-file-pdf` 15, `room-reads-shared-chats` 6, `safe-ops-matrix` 14, all 0 fail.
`permission-matrix`: 2341 pass, 3 fail, the same 3 on base `dev` without this change (route coverage: 46 routes have no
case; `driveShareFolders` answers 404 `drive_not_found`). The new side chat and quote tests fail on the old gate code
and pass with it.
