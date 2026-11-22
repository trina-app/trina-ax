# Scenario QA follow-ups 11-22: a room link someone can't open, lost group access, the quote and guest sends, a guest who left

- Date (UTC): 2026-11-22 08:18
- Branch: `fix/qa-scenario-followups-1122` (off `batch/20261122-i` cc98820f1)
- Status: in progress
- Where: server/src/chat, server/src/rooms, shared/src/api, web/src. Why: four scenario QA fails of 11-22 (S-110, S-118,
  S-119, S-120) that leave a person at a dead end or make the AI say wrong things.
- Version impact: patch (the same screens and cards with a missing step or line added; no new setting or table)

## Goal

QA rows (sheet "QA"): TC-v1e-03 and TC-v2f-A1 (S-120), TC-v1e-06 and TC-f4-02 (S-118), TC-v1e-07, TC-f4-04 (S-119),
TC-v1d-06 and TC-f4-09 (S-110).

1. **S-120** 한지우 has the AI post a PDF link from `groups/영업/` to #영업-보고. The card says "링크된 파일 1개를 1명이
   열 수 없어요" and offers only Send / Always allow / Don't send. 최도윤 (not in 영업) clicks the link, sees "파일을 찾을
   수 없거나 볼 권한이 없어요", and has no next step.
2. **S-118** 박준호 is moved out of 영업 mid-chat. The AI says "could not search" / "영업 폴더는 목록에도 보이지
   않았습니다", asks for a path, and takes back a B형 price it had read from the file. The admin's group screen does not
   say the change applies at once.
3. **S-119** "대한물산 견적서 만들어줘" gets a questions card instead of a read of the 영업 단가표. The card for 정하늘
   (an outside guest) never says she is a guest. "하늘님한테도 보내줘" also sends a second DM to 김민지.
4. **S-110** after 정하늘 (guest) is removed, her old room messages show plain "정하늘" with no guest or left mark.

## Scope

In:

- (superseded in part by "After the plan review" below) **S-120 viewer: "Ask to add it" in a room.** The #320 chat-file ask (components/ChatFileAsk.tsx, chat/access-requests.ts
  fileView / fileRequest / answer) gets a room twin. The viewer is a room member (not a guest) who cannot read a
  team-path link in a room message. The message's author can still read the file. The viewer then sees "이 파일은
  {name}님만 방에 추가할 수 있어요" and **[추가 요청]**. The ask goes to the author's Activity. **[방에 추가]** checks
  again (author still reads it, still a member, message still there) and attaches a copy to that message (the copy Send
  makes today, `attachedLinksOn`), so the link opens the copy for everyone in the room. Every other case gets today's
  one line, which says nothing about the file. Routes: `GET/POST /api/rooms/:id/file-access` (`path`, `messageId`). It
  uses the same `access_requests` rows and limits as #320: kind 'chat' with a `room/` target prefix. No migration,
  unless the reviewer asks for a kind of its own (then the next free number on dev).
- **S-120 poster: the card names who can't open, and offers a copy.** On post_to_room's card, a linked file in a team
  folder (`shared/`, `groups/…`, a project) that the asker reads but may not share: the card names the room members who
  can't open it ("최도윤 님은 링크된 파일을 열 수 없어요"). Who can open a team folder is the folder's rule, not someone's
  private choice. A teammate's own file, or one reached through a share, still gets a count only (review of #1235). The
  card then gets **[사본 첨부해서 보내기]** (main: a copy goes with the post, kind `post_files`), **[링크만 보내기]** and
  **[보내지 않기]**, plus Always allow, which answers as the main button (Rule A). Today's view-grant path for files the
  asker may share is unchanged.
- **S-118 tool results say the access ended.** An earlier answer of this chat, in this person's own turn, read a path
  under a folder. When a later file tool refuses that path with "not found or no access", the result gets one line:
  access to the place ended ("이 폴더는 더 이상 열 수 없어요"), whom to ask (an admin, Admin › Groups), and that earlier
  verified figures stay true. A search (glob/grep/list) that skipped such a folder gets the same line once a turn. Only
  places this person's own earlier reads in this chat named are mentioned, so nothing new is revealed. Prompt rule: do not
  take back facts verified earlier in this chat unless they are now known to be wrong. Admin › Groups (members edit)
  gets one line: "그룹을 바꾸면 폴더 접근도 바로 바뀌어요."
- **S-119 look first, guest words, the named person only.**
  - A prompt line next to fix/ask-less's ACT_FIRST_RULE (not on this base; worded so the two sit together): a document
    that needs the team's facts (a quote needs prices) looks first in the obvious places the user can open (a price list
    in their group folder, earlier quotes). Blanks are only for what is not found, and the AI does not ask first.
  - post_to_room and share_with_person to a guest (a DM, a new 1:1 chat, the file share): one line "{name} 님은
    게스트(외부)예요. 초대받은 곳만 볼 수 있어요."
  - post_to_room to a person or a 1:1 chat refuses when the asker's own message of this turn names another teammate and
    not this one. The result tells the AI to send only to the person named, and the AI is told that "도 / also / too"
    never means sending again to earlier recipients.
- **S-110 the left mark.** Room messages carry `authorLeft: 'member' | 'guest'` for an author whose account is turned
  off or removed. The run's name shows "나감" or "게스트 · 나감" beside it, in all five languages.

Out: the file panel's "made by" line for a removed guest (TC-f4-09's file half), the ICU text in the guest-removal
dialog (TC-v1d-05), ask-less's own rules (another branch).

## After the plan review (2026-11-22)

The review changed three things:

- **No copy past the folder rule.** A copy (card or viewer) goes only for a file the asker may share
  (`FileShares.view(...).canShare`). A team-folder file they only read stays a link, as decided in 20261117. So the
  first fix is the root cause: why 한지우's own AI-made file in `groups/영업/` counted as "not hers to share". If she is its
  owner, today's card already names 최도윤 and lets him view it. For a file she really may not share, the card now still
  **names** the room members who can't open it, and the post's step offers the existing "Ask <owner> / Ask an admin".
- **The viewer's ask uses the file requests** (`file_access_requests`, files/shares.ts request / answer, Share or Decline
  by the file's owner or admins). There is no new kind and no edit to the posted message. The new route is
  `POST /api/rooms/:id/messages/:messageId/file-access` (+ GET). It answers only for a team path that is a link in that
  message and that the viewer can see (`canSee`, thread, history), so it can't be used to probe paths. Everything else
  gets the one generic "no". Guests never ask. The web panel shows "볼 권한이 없어요 · [보기 요청]", or "요청했어요 …".
- S-118 uses `chat_reads` (this person's own reads on this branch). The note fires on an earlier read plus a refusal,
  never on whether the path exists, and reads "더 이상 열 수 없어요 (권한이 바뀌었거나 옮겨졌어요)". The search line is
  added only when the search's scope covers a folder this person read earlier.
- S-119: share_with_person tells the AI when the only match is a guest, instead of dropping her silently. The
  named-person guard refuses only when the asker's own message names another active teammate and not this one. Any
  doubt shows the card.
- S-110: "나감" for any turned-off account (a member who left the team too), "게스트 · 나감" for a guest. Guests viewing
  see it as well.

## Steps

1. Plan (this file), independent plan review.
2. S-120 viewer: shared API types and routes, server room file-ask (view / request / answer → copy onto the message),
   Activity text and button, web RoomFileAsk where FileBody shows preview.notFound for a room link; tests.
3. S-120 card: nameable team-folder files, the copy choice; tests in b-post-to-room / c-who-can-open.
4. S-118: lost-access note in afterFileTool, prompt line, admin line; tests.
5. S-119: prompt line, guest line, named-person guard; tests (and the engine prompt pins).
6. S-110: authorLeft, RunName tag; tests.
7. changes/qa-scenario-followups-1122.md, decision file for the S-120 naming and copy rule.
8. typecheck, check:prepush, area + web tests on the Mac mini (Bun 1.3.12); real claude-code run of S-118, S-119 and
   S-120 on a private QA copy; independent code review; one PR to dev, not enqueued.

## Decisions

`docs/decisions/20261122-room-link-ask-and-team-file-names.md`: the card names people for team-folder files and offers a
copy. The viewer asks the poster to add it. Narrows the "names only for files the asker may share" rule of
[20261117-send-to-room-card-two-buttons](../../decisions/20261117-send-to-room-card-two-buttons.md) for team folders.

## Risks

- Naming people for a group folder file tells the asker who is outside that group. That is the folder rule, and the
  room's member list shows them anyway. A teammate's own or share-reached file stays counted.
- A copy on the viewer's ask reaches everyone in the room, guests included. The author's Activity text says so, and the
  author presses it.
- Lost-access note: it must never name a place the person did not read in this chat themselves (a shared chat's other
  members' reads do not count).
- Prompt text is pinned by tests (engine prompt pins). Update them in the same commit.
- Five languages for every new string (check:i18n).

## Tests

`bun run typecheck`, `bun run check:prepush`, the unit tests for b-post-to-room, c-who-can-open, access requests,
share-with-person, rooms and the prompt pins, the new tests, the web unit tests for ChatFileAsk / RoomFileAsk /
MessageRun / admin groups, on Bun 1.3.12 (Mac mini).

## Result

(filled in at the end)
