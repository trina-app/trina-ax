# Someone asking to open my file is a push; one "File sharing" switch covers both file pushes

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/file-share-push-gaps (file sharing P2, PR 4; QA TC-3093 "P2"; plan
  [20261116-1129-file-share-push-gaps.md](../AGENTS/plan/20261116-1129-file-share-push-gaps.md))

- **Ask:** an "Ask for access" request is the one file event where someone waits, and it reached the owner only in
  Activity. File pushes had no switch of their own.
- **Rule (push):** `file.access_requested` is a push event. It goes to everyone the request went to (the file's owner;
  for a team file nobody can answer, the team owner and the admins), carries the notice id and the code only, and the
  lock screen says the generic "Someone asked to open a file." ("누군가 파일을 열게 해 달라고 요청했어요.";
  server `notifications/text.ts` and gateway `push-gateway/src/text.ts`, kept equal by a test). Never the file's name,
  the asker or the note. It is sent and retried only while the notice is unread, the request is still `pending`, the
  receiver may still answer it (the same check as Activity's Share / Decline, `FileShares.requestWaitsOn`), the asker is still active, outside
  their quiet hours and with the switch on. So once one admin answers, the others' pushes stop.
- **Rule (tap):** a tap opens `/activity/<notice id>` (a phone notification may name a path only, no query), which
  opens the notice by itself (`/activity?n=<id>`; the page reads it signed in, so the id opens only the person's own
  notice). The browser's service worker takes the id from its signed-in fetch of the notice, never the payload, and
  shows nothing when that notice says the request can no longer be answered.
- **Rule (again):** a new request for the same file by the same person (after an answer; there is never a second
  waiting one) re-arms the Activity row and is pushed again. The existing limits bound it: one waiting request per file
  and person, 5 a day to one owner, 20 an hour per person.
- **Rule (limits, security review of #1118):** at most 10 request pushes a day reach one person
  (`FILE_REQUEST_PUSHES_PER_DAY`, counted per request over the deliveries; the request limits are per asker, so many
  askers could otherwise ring one owner without end); past it the requests land in Activity alone. A request whose
  asker was switched off or removed is not pushed. A request made before this server applied migration 358 is never
  pushed (its `applied_at`), so the update does not ring every unread request of the last day at once.
- **Rule (switch):** Settings › Notifications **File sharing** ("파일 공유"), on by default, covers the push of a file
  shared with me by name and of a request to open my file (`notification_preferences.file_shares`, migration 358,
  additive, reader 1; `pushEventEnabled`). Off cancels what waits for a retry; the Activity rows stay as they are.
  Named "File sharing" rather than "Files shared with me" because half of it is about my own files.
- **Not done:** the iPhone extension naming who shared or who asks, and `/f/*` as an app link (both need a store
  build); a push for a decline or for grants removed by a move (nobody waits on them); a push for a share through a
  group or the whole team (Activity only, as before).
- **Tests:** `tests/unit/c-file-share-push-gaps.test.ts`, `push-gateway.test.ts`, `push-locale.test.ts`,
  `b-rooms-notify.test.ts`, `web/test/unit/push-worker.test.ts`, e2e `web/test/e2e/file-share-push-setting.spec.ts`.
- **Version impact:** minor (a new push event and setting, an additive migration). The gateway's new line ships with
  the release train; an older gateway says "You have a new notification".
