# Many pictures, follow-ups: scans and frames go smaller too, a second read is full size

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (adds to [Many pictures in one answer](20261118-limits-images.md))
- Branch: fix/limits-images-followup (re-review of #1287, QA TC-4931)

- **Scans and frames:** PDF page images and video frames go through the same rule as read images
  (`FileService.turnSized`): the full-size allowance below, the next ones at 768 px, at most
  150 KB. Before, they always went at full size, so a chat that gathered scanned pages over several answers could bring
  the engine's own request past the proxy's 64 MB (`PROXY_BODY_MAX`), and every request after that failed with 413.
- **Full-size allowance:** at most 16 pictures of an answer (and 10 MB of base64) go at full size
  (`TurnFiles.fullCount`, `fullBytes`): the first 12 new ones (`VISION_TURN_FULL_NEW`, was 16 since #1287), and up to
  4 more for pictures read a second time in the same answer (`TurnFiles.imagesShown`, one set for the turn and its
  sub-agents). A second read past the allowance comes smaller like any other. The `read` description says so ("up to
  4 times an answer").
- **Caps count the engine session, not only the answer:** a resumed session sends every picture it holds again with
  each request. The pictures the resumed session brings along (`sessionPictures` in `chat/session-slim.ts`: the image
  blocks of its messages, each once, not Claude Code's `toolUseResult` copy) are taken at the answer's first launch
  (`TurnFiles.carriedImages`, `carriedBytes`) and count against the answer's caps (200 / 48 MB with the proxy, 90 /
  20 MB without). Past 80% of the bytes cap (`VISION_SESSION_SHRINK_SHARE`) every new picture goes smaller, second
  reads too. A session that would carry more than half the caps into the next answer is not kept
  (`sessionPicturesKept`, in `stashSession` after the slim that takes older turns' pictures out): the next answer
  starts fresh, from the chat's summary. So an answer always has room for its own pictures, and the engine's request
  stays under the proxy's 64 MB (`PROXY_BODY_MAX`) however many answers came before, also on models that never compact.
- **Proxy conversions** (`server/src/proxy/fit-images.ts`):
  - a picture whose conversion failed `FIT_TRIES` (2) times counts as "cannot be made smaller" and is not tried again;
    a busy or overloaded server (`vision_busy`, `vision_heavy`: time or memory) says nothing about the picture and never
    counts;
  - the caches let the least recently used entry go first (a hit is set again);
  - at most `FIT_QUEUE_MAX` (64) conversions wait; past it a picture goes on as it is, and a later request makes it
    smaller.
- **Left out:** a full-size second read in a later answer (an answer's first 12 are full size anyway); a test with a
  real video (frames use the same code path as pages); an end-to-end test of the session drop in `stashSession` (the
  rule is `sessionPicturesKept`, tested on its own and in the six-answer chain).
- **Tests:** `tests/unit/vision-read.test.ts` (36 + 20 scanned pages over two answers, the second read and its
  allowance, six answers heavy with photos in one session under the caps), `tests/unit/session-pictures.test.ts`
  (each picture once, when a session is kept), `tests/unit/fit-images.test.ts` (retry cap without busy or overloaded,
  LRU, bounded queue).
- **Version impact:** patch.
