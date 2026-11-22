# Send to room: start the MP4 at the confirm, check again after the wait, say when the page went

- Date (UTC): 2026-11-22 08:19
- Branch: `fix/send-to-room-render-early` (off batch/20261122-i)
- Status: done
- Where: server/src/chat/answer-share.ts, post-to-room.ts, room-copy-words.ts; web ShareToRoom / SendHere; ko i18n.
  Why: batch-2 re-review of #363 (three should-fixes, two nits).
- Version impact: patch: fixes to #363 before release.

## Goal

The confirm named "제목.mp4" but the page went when the render was slow or queued; the yes was not checked again after
the wait; "<name>님만 볼 수 있는 자료" could be cut; ko said "모두" for one person.

## Scope

In: the render starts when the check first runs (the confirm), the yes waits (100 s at most) before its checks run;
a video that goes as its page is said in the result, the toast and post_to_room's result; the name pattern only takes
the AI's own note about a file; ko audience line without "모두". Out: nothing else.

## Steps

1. server; 2. web toast + i18n; 3. tests.

## Decisions

none.

## Risks

The yes may wait up to 100 s while a render runs (as before, now before the checks).

## Tests

tsc server/web, b-answer-share, b-post-to-room, i18n-languages/completeness, web side-chat-send / share-to-room.

## Result

See the PR.
