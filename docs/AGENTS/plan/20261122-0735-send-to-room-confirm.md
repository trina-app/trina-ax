# Send to a room: one confirm with a preview, no failure notes, the video as a video

- Date (UTC): 2026-11-22 07:35
- Branch: `fix/send-to-room-confirm` (off batch/20261122-i)
- Status: done
- Where: server/src/chat/answer-share.ts, shared step labels, web ShareToRoom / SendHere / Messages. Why: QA TC-v2f-A2,
  A3, A4, TC-f2-c03, c04.
- Version impact: patch: fixes to sending an answer to a room; no migration.

## Goal

The side chat's "대화에 보내기" posted with one click, posted an answer that only said a share failed, attached no
file, showed "Post to room placeholder" as a step, and sent a promo video as ".html 50 KB"; the main chat's button
asked for a chart but not for an Excel file; "한지우 님만 열 수 있어요" survived the room copy.

## Scope

In: `preview` on the share request (the apps' first press always gets one confirm: the text exactly as it goes, who
will see it, the files); an answer whose last step failed and that made nothing is refused (409 answer_failed) and the
button is hidden under it; a promo video is rendered to MP4 on send where this server can render, its page only if that
fails; "<name> 님만 열 수 있어요" is left out; a made-up name of one of our tools reads as that tool.
Out: files a turn saved but did not link (they still go only through links).

## Steps

1. server preview + answer_failed + render-on-send + regex; 2. web confirm preview/audience; 3. step label; 4. tests.

## Decisions

none (the confirm step is the existing ShareConfirm, now always shown first).

## Risks

A share now always takes two requests (preview, then yes). Rendering waits up to 5 minutes on a dev Mac.

## Tests

typecheck, area tests (b-answer-share, step-labels-tools, i18n-languages), web side-chat-send / share-to-room /
side-chat; real claude-code run on a QA copy.

## Result

See the PR.
