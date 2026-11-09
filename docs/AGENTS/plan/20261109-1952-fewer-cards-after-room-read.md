# Fewer cards after a room read: my own folder, and one yes per team folder

- Date (UTC): 2026-11-09 19:52
- Branch: `feat/fewer-cards-after-room-read`
- Status: done
- Where: Team AX core (`server/src/chat`, `server/src/rooms`). Why: the room-read change card is a core permission rule
  (docs/REPOSITORY-RULES.md).
- Version impact: minor (fewer cards after a room read, a reversed decision, one additive migration; no API change)

## Goal

The owner (2026-11-10): "허용 계속 눌러주는게 지치겠다". After a chat reads a room (the ✦ side chat nearly always does),
every change raises a card, one per file. Changes 1 and 2 of the card-fatigue audit, within the bounds the owner
approved.

## Scope

In:

1. **New files in my own folder go without a card after a room read.** In my own chat (side chat included) with
   `chats.rooms_seen`: write, make_file, edit_hwp and save_room_file making a NEW file under `users/<me>/`, and
   edit / write / edit_hwp of a file this same answer made (`roomMadeHere`). Still asks: `users/<me>/skills/`,
   instruction-named files (`instructionLike`), `.attachments` and any hidden folder, a plugin's folder, every file that
   existed before this answer, edit_files, moves, copies, renames and every other tool. save_url keeps its card: its
   file's name comes from the download (the extension follows the bytes), so "new" cannot be known before it runs. The
   step line ends "내 폴더라 묻지 않고 저장" (5 languages). Scheduled runs that read a room can now save new files in
   the person's own folder (plan C item 1).
2. **Close the memory gap.** A turn records what its chat had seen (`turns.outside_content`, migration 281: 1 = other
   people's content, `chats.session_tainted`; 2 = a room's messages or something from outside the team,
   `chats.rooms_seen`, a room session, `chats.room_outside`). When a chat later reads a file of the person's own folder
   (the read paths `noteReads` already records: read, grep, search, make_file's sources), the newest content's turn
   (`files/timeline.ts`, which follows moves and copies) decides: 1 taints the chat (remember asks), 2 also marks it as
   having used outside content (no room cover). A turn of this same chat on the current branch adds nothing (its marks
   are the chat's already). A missing turn row counts as 2.
3. **One yes covers a team folder for the rest of the answer.** In my own chat after a room read, a NEW file (or one
   this answer made) in a team folder that every member of every room in the chat's read scope may write
   (`roomGrantTarget`, the #198 checks) gets the room card's words; its [이번만 허용] covers new files in that folder for
   the rest of the answer. Not covered: existing files, other folders, skills and instruction files, the wider-audience
   card (asked as today), a scheduled run, and any chat that used outside content: own chats now set
   `chats.room_outside` for every tool outside the team-file tools (the web, a search, a connection, the browser, a
   computer, tools added later), kept until a new session (an own chat's session carries earlier answers).
4. **"이 방에서는 항상 허용" in the side chat.** A ✦ side chat whose read scope holds only its own room offers the room
   card's third button; it makes and uses the same #198 grant (asker × room × folder, new files, 30 days, every member
   writing, `members_since`, `folder_id`), listed and revoked in Settings › 트리나에게 허용한 것. A grant made in the room
   covers the side chat and the other way round. No new row type, control or endpoint.
5. **Wording.** The wider-audience card names the AI as the room cards do (`aiCalled`: 트리나 where the product is named
   after its AI), so the merged card no longer says "트리나가" then "AI가".
6. Docs: DECISIONS (reverses 2026-11-09 "a room file saved into one's own folder always asks", with the owner's reason
   and these bounds), PERMISSIONS, CHANGELOG, the room tools' prompt line.

Out: change 3 (connection reads, folding the room card into tool cards: `feat/room-read-connection-cards`), change 4
(grouped "모두 허용"), the site allowances in Settings.

## Steps

1. Plan (this commit).
2. Migration 281 `turns.outside_content` with a backfill from the chats' marks; the turn keeps it in step (start,
   taint, room read, outside use, after each tool).
3. `noteReads` checks own-folder reads; server tools' reads are drained right after the call.
4. `confirmRoomChange`: own-folder cover; own-chat team cover with [이번만] and the side chat's grant; recheck before
   the write for own chats too.
5. Texts (step line, wider-audience card's `{ai}`, Settings › 허용한 것's line), prompt line.
6. Tests: rooms-save, room-ai-grants, chat-rooms (update the old ones; add the planted-message, memory-gap, team-folder
   and side-chat cases).

## Risks

- Migration 281 (highest on dev is 280; none of the open PRs adds one). Additive; an older build ignores the column.
- Security: planted room text can add new files in my own folder (seen in the steps and the file list; versions and the
  trash undo them) and, after one [이번만] or a grant, new files in a folder every member of the room may write. It
  cannot overwrite anything that existed before the answer, write skills or instruction files, reach more people, or
  steer a cover after the web or a connection was used. Laundering through my folder is closed by item 2.
- Conflicts with `fix/ai-refusals-clear` (confirmRoomChange's refusal) and the other open PRs on turn.ts and the docs.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; the chat, room, room-ai-grants, memory and schedule suites
and the security matrix; the whole `tests/unit` against dev; the web unit tests in Docker; e2e for the side chat and
the room cards.

## Result

Built as planned, with these differences:

- **save_url keeps its card** in the own folder (its file name follows the downloaded bytes, so "new" is not known
  before it runs). Flow e goes 3 → 2, not 0.
- **The own chat's outside mark lasts until a new session**, not one answer: an own chat's session carries earlier
  answers. `rooms` (the list of rooms) counts as outside too.
- **The wider-audience card's yes covers that call only**, as in a room; [이번만 허용] on the room card is what covers
  the folder. A folder wider than the rooms read takes two cards for several files (b, f).
- **Independent security review**: one must-fix (edit_hwp's output judged on the raw path: `x.hwp/` overwrote x.hwp; also
  in a room session's grant on dev) and five should-fixes, all fixed and re-checked: the mark follows the bytes
  (`file_events.sha256`, new index), older own chats are marked from their answers' steps, an attached own file counts,
  `rooms` counts as outside, and a project's folder still asks (its dev environment may run a new file by name).
- Cards in the audit's six flows: a 1 → 0, b 1 → 1, c 4 → 4 (change 3), d 3 → 3, e 3 → 2, f 5 → 1.
- PR: https://github.com/trina-app/trina-ax/pull/275
