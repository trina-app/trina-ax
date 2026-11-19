# Many pictures, follow-ups: scans and frames go smaller too, re-reads at full size, bounded conversions

- Date (UTC): 2026-11-18 22:35
- Branch: `fix/limits-images-followup`
- Status: done
- Where: trina-ax core, `server/src/files/service.ts`, `server/src/proxy/fit-images.ts`, `shared/src/tools.ts`. Why: the re-review of #1287 (QA TC-4931) found gaps in the same code (see docs/REPOSITORY-RULES.md)
- Version impact: patch, no new setting

## Goal

#1287 (docs/decisions/20261118-limits-images.md) sends pictures after a turn's first 16 smaller and fits each model
request in the proxy. Its re-review found:

- PDF page images and video frames always went at full size, so a chat that collects scans over several turns could
  push the engine's own request past the proxy's 64 MB limit and get stuck on 413.
- The read tool told the AI to read a picture again for its details, but a second read came back small too.
- A picture whose conversion a limit stops was tried again on every request.
- The proxy's cache let the oldest copy go first even when it was in use, and its conversion queue had no bound.

## Scope

- `turnSized` for PDF page images and video frames, like reads.
- A picture read a second time in the same answer comes back at full size (it counts like any other); the read tool
  says so.
- Retry cap: after 2 failures of the same picture (not a busy or overloaded server) it counts as "cannot be made
  smaller".
- After review: caps count the engine session's pictures (resumed sessions send them all again); a session past half
  the caps starts the next answer fresh; second reads share the 16 / 10 MB full-size allowance (12 new + 4 again).
- LRU on a cache hit; a queue of at most 64 conversions waiting, past it the picture goes on as it is.

## Tests

- Unit: 36 + 20 scanned pages over two answers (pages after the 16th at 768 px); the second read at full size; the
  retry cap; LRU; the bounded queue.

## Result

Built as planned; decision in docs/decisions/20261118-limits-images-followup.md.
