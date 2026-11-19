# A video, a sound or a picture is on its own dark stage, never on a document's paper

- Date: 2026-11-19
- Status: accepted
- Supersedes: none
- Branch: fix/video-preview-stage (the owner, QA TC-5367)

- **Ask:** on 0.5.18 (Mac app) an mp4 opened from a room thread, with the thread column open, showed a black header, a
  dark grey band on the left, a black band on the right, a white page column in the middle and the video as a black
  box stuck at its top with white space below. It should look like an image or video viewer in Slack, Google Drive or
  Quick Look.
- **Cause:** the room file viewer ([The room file viewer](../DECISIONS.md#the-room-file-viewer--a-file-from-a-team-conversation-opens-over-the-whole-window-like-slack-featroom-file-viewer-2026-11-09))
  drew every file in the 960 px reading column (`bg-surface`, the paper a PDF or Word file is drawn on), and the player
  (`FileBody` MediaView) sat at the top of it with `p-4 w-full max-h-[80vh]`.
- **Rule:** a video, a sound or a picture has no reading column in the viewer: it fills the stage left of the
  conversation column. `MediaView` draws one dark stage (`#0d0d0c`, the viewer's own backdrop, `color-scheme: dark`
  for the player's controls) that fills the body wherever it is: the viewer, the side panel (Files, the AI chat) and a
  shared file's page. A video is centred both ways and as large as fits, keeping its shape: its width is
  `min(100cqw, shape × 100cqh)` of the stage's inner box, so the player's controls stay on the picture (an
  `object-contain` box as large as the stage would spread them across the letterbox). A sound's player is centred, at
  most 36rem wide. A picture drawn as a file in the viewer (a converted HEIC photo) is centred both ways. Documents
  (PDF, Word, slides, sheets, text, Hangul) keep their column; the side panel's own picture is unchanged.
- **Tests:** `web/test/e2e/media-preview-stage.spec.ts` (landscape and portrait from a room message, a thread with the
  column open, a phone, a small window, the side panel; nothing light behind the video; a PDF keeps its 960 px column),
  `web/test/unit/file-body.test.tsx`. Fixtures: `tests/fixtures/video/` (VP8 and Opus: Playwright's Chromium plays no
  H.264; an mp4 was checked in Google Chrome on a copy of the QA team).
