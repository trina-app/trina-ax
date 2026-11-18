# Many pictures, follow-ups: scans and frames go smaller too, a second read is full size

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (adds to [Many pictures in one answer](20261118-limits-images.md))
- Branch: fix/limits-images-followup (re-review of #1287, QA TC-4931)

- **Scans and frames:** PDF page images and video frames go through the same rule as read images
  (`FileService.turnSized`): the first 16 of a turn (or 10 MB of base64) at full size, the next ones at 768 px, at most
  150 KB. Before, they always went at full size, so a chat that gathered scanned pages over several answers could bring
  the engine's own request past the proxy's 64 MB (`PROXY_BODY_MAX`), and every request after that failed with 413.
- **A second read is full size:** a picture read a second time in the same answer comes back at full size (it counts
  against the turn's caps like any other; `TurnFiles.imagesShown`, one set for the turn and its sub-agents). The `read`
  description says what happens: after the first 16 pictures of an answer the next ones come smaller, earlier
  pictures are kept smaller, and a second read in the same answer gives the full size.
- **Proxy conversions** (`server/src/proxy/fit-images.ts`):
  - a picture whose conversion a limit stopped `FIT_TRIES` (2) times (time, memory, a replaced work folder) counts as
    "cannot be made smaller" and is not tried again; a busy server (`vision_busy`) never counts;
  - the caches let the least recently used entry go first (a hit is set again);
  - at most `FIT_QUEUE_MAX` (64) conversions wait; past it a picture goes on as it is, and a later request makes it
    smaller.
- **Left out:** a full-size second read in a later answer (the turn's first 16 are full size anyway); a test with a real
  video (frames use the same code path as pages).
- **Tests:** `tests/unit/vision-read.test.ts` (36 + 20 scanned pages over two answers, the second read),
  `tests/unit/fit-images.test.ts` (retry cap, LRU, bounded queue).
- **Version impact:** patch.
