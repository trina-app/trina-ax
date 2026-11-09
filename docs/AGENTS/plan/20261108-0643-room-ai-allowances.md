# Room AI: allow new team files in advance ("이 방에서는 항상 허용")

- Date (UTC): 2026-11-08 06:43
- Branch: `feat/room-ai-allowances`
- Status: done
- Where: trina-ax core (`server/src/chat/`, `server/src/rooms/`, `shared/src/api/`, `web/src/`). Why: rooms, the AI's
  confirmation cards, permissions and settings are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new card choice, a new personal settings section, a new team setting and a migration
  (additive; an older build ignores the table).

## Goal

The product owner (2026-11-08): in a team chat room every change @트리나 makes raises the server card, and one save can
raise two (the room card, then the wider-audience card). A daily job such as "@트리나 /견적서 만들어줘" stops one to three
times per answer. One principle: creating new team files can be allowed in advance (team files have version history and
a trash bin); anything that cannot be undone or reaches more people still asks every time.

## Scope

In:
- Room card choices: [이번만 허용] [이 방에서는 항상 허용] [허용 안 함] and one line under them ("내가 부를 때, 이 폴더에
  새 파일을 만들 때만 적용돼요."). A compact three-button layout for that card (390 px, dark mode).
- "항상" is offered only when every target qualifies:
  - session: a room session (not the person's own chat after a room read, not a scheduled run, not a confidential
    chat);
  - tool: write / make_file / edit_hwp making a new file, or edit / write / edit_hwp of a file this same answer
    created (from the file layer's create events of this turn, not `filesWritten`, which also holds updates);
    never edit_files, moves, copies, renames, save_url or any other tool;
  - path: resolved with `authorize(…, 'write')` (case, NFC/NFD); the folder exists; never the team root, a top-level
    folder, a group's or a person's root folder, a plugin-managed folder, skills/ or a skills folder, or an
    instruction-like file (`instructionLike`);
  - writers: every current room member may write the target (authorize per member) (security re-check);
  - the team's admin switch is on.
- "이번만" covers the rest of this answer for that folder and its subfolders, for the same kind of calls only (new files
  and files created in this answer), under the same path and writers checks; anything else keeps today's exact-call
  memory, and an edit of a file that existed before the answer always gets its own card.
- Subfolders: coverage stops at the first subfolder with its own folder rules, and the target's own folder must have
  the same readers and writers as the granted folder (fingerprint).
- The grant (migration 266, `room_ai_grants`): asker × room × folder (subfolders) × new files, 30 days. Checked again
  at every use: expiry, the asker still a member and the room not archived, nobody joined after the grant, the folder's
  readers and writers unchanged (fingerprint like tools/file-moves.ts), every member and the asker may still write,
  the admin switch on (off: ignored, not deleted; any other lapse deletes it). Leaving a room deletes the asker's
  grants there. Audit rows for created, revoked and used (DMs and group chats by kind only, `roomAuditRef`).
- With a valid grant `confirmRoomChange` asks nothing; the step line says "항상 허용으로 진행", and the room answer lists
  the files a grant let the AI create, so teammates see them.
- One card per call: when a call needs both the room card and the wider-audience card, only the wider-audience card is
  shown, with the room card's details (what it writes), no "항상"; its yes covers the room change of that call. The
  widening need is computed before the room card is raised; make_file's later card (images, templates) never counts as
  the room yes. The skill-write card, `authorize` and the room-share decision are unchanged.
- Copy: every server card is titled "확인해 주세요"; the room card body says what the AI will do and "바뀐 파일은
  기록에서 되돌릴 수 있어요." (no "다른 사람의 메시지도 있어요"). Five languages.
- Settings › 트리나에게 허용한 것 (account group): one row per grant (room as the person sees it → folder · 새 파일 저장 ·
  date · [지우기]), an empty line, list and delete endpoints (`/api/ai-allowances`, made so site permissions can join in
  PR 2). Only one's own grants (another person's id answers 404).
- Admin › Team settings › AI: "대화방에서 '항상 허용' 쓰기" (on by default, one line of help).
- DECISIONS.md entry amending "Every change waits for the asker"; CHANGELOG entry.

Out: site permissions in the new settings list (PR 2); grants in a person's own chat; any change to moves, copies,
renames, save_url, schedules or connections in rooms.

## Steps

1. Migration `266_b_room_ai_grants.sql`; `server/src/rooms/ai-grants.ts` (qualify, fingerprint, create, use, lapse,
   list, delete, leave) and the delete in `Rooms.forgetMember`.
2. `chat/turn.ts`: `confirmRoomChange` with the three choices, the answer's folder coverage, the grant, the merged
   wider-audience card (`widenNeed`), step patch; `chat/tools.ts` passes the widening target in.
3. `rooms/ai.ts`: the created-files line under a posted answer.
4. Shared API (`ai-allowances.ts`, `AskUserRequest.note` / `buttons`, `TeamSettings.roomAlwaysAllow`), server routes.
5. Web: AskCard's three-button layout and note, the title, Settings section, admin switch, i18n (5 languages).
6. Tests (server unit per guardrail, web unit, a new e2e spec on rooms-mock), screenshots, docs.

## Risks

- Security: a grant must never widen what a call can do: it only skips the asker's card, every other check (authorize,
  skill card, wider-audience card, room-share decision) still runs. Fails closed on any error.
- Migration 266: the highest number on dev is 265 (dc452044) and no remote branch has 266.
- Five app languages; Korean only in `ko:`; phone width and dark mode for the card and the settings list.
- The three-button layout must not change the address card or the schedule card (they keep their radios).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; server unit: the room suites (`b-rooms-ai*`,
`b-codex-rooms`, `b-chat-rooms`) and a new `b-room-ai-grants.test.ts` (one test per guardrail); web unit in Docker
(as CI); `bun run --cwd web build` then the full web e2e and the new `room-ai-allow.spec.ts`.

## Result

Built as planned, with the security re-check's changes (writers check per member at offer and use, the merged card
carrying the room card's details with the widening need computed first, "made in this answer" from the turn's
`file_events` creates, coverage stopping at a ruled subfolder, the created files named under the answer).

Review of PR #198 (fixed on the branch): [이번만 허용] covers the folder only on a card that offered "always" (its
uses audited and listed like a grant's); a member who joins while the card is open lapses the grant (`members_since`);
nothing is covered once the question used the web (`room_outside`); the audience hash leaves out people with no access;
a grant is bound to the folder on disk (`folder_id`); make_file is checked at its real path; a covered call is checked
again right before it writes. Design change: a team room as a source does not count as narrower when only owners and
admins who would see it on joining are missing (`wouldSeeFrom`).

Differs from the brief, and why:
- [이번만 허용] is held to the same checks as "always" (otherwise it covers that one call, as before): the steering risk
  the writers check closes exists within one answer too.
- The merged card also applies in the person's own chat after a room read (the same two cards per save), with the
  rooms-seen line in front of the wider-audience question.
- Lapsed grants are deleted when found (audited) so a change back does not revive them; the admin switch only ignores.
- Settings section label follows `PRODUCT_NAMED_AFTER_AI` ("AI에게 허용한 것" in the core edition).
- Known limit, for the owner: a room question with earlier messages in its context counts the room as a source, so a
  save where people outside the room can read still shows the wider-audience card, once, unless (team rooms) only
  owners and admins who would see the room on joining are missing.

PR: https://github.com/trina-app/trina-ax/pull/198
