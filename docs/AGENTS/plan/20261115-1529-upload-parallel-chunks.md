# Faster large uploads, and "Getting it from iCloud" while a cloud file downloads

- Date (UTC): 2026-11-15 15:29
- Branch: `perf/upload-parallel-chunks`
- Status: done
- Where: trina-ax (Team AX core: web upload pipeline `web/src/lib/upload.ts`, `folderUpload.ts`; desktop read path
  `desktop/src/common/work-files.ts`). Why: uploads and Find work files are core features (see docs/REPOSITORY-RULES.md)
- Version impact: patch, faster uploads and one more status line; an optional field in the desktop bridge's read

## Goal

Through the Cloudflare tunnel one upload stream to a Seoul team server gets 5-8 MB/s from Jakarta; three streams together
get about 12.4 MB/s, and each request costs about 140 ms. A large file goes up one 8 MB chunk after the other, so it gets
one stream. Send two or three chunks of the same file at once, for about twice the speed on files over 8 MB.

Find work files reads a file through the desktop app. A file whose content is only in the cloud (iCloud, OneDrive,
Google Drive) downloads first, and the page says "Preparing" for up to a minute. Say "Getting <name> from iCloud…"
instead, apart from "Uploading", and say clearly when the minute ran out.

## Scope

In:
- `upload.ts`: up to 3 chunks of one file at a time (a small scheduler, unit tested), still in the page's one line of
  uploads; that line goes from 3 to 4 requests at once for the whole page (6 at most with stalled ones). Ascending chunk order, a retry per chunk, a
  failed chunk stops the file (the others are stopped too), resume from what the server has, complete after all.
- Progress counts each chunk on its way.
- Desktop read: before it reads, the app checks whether the file is in the cloud only (a Mac's SF_DATALESS; on
  Windows the index's attributes, or a slow read in a cloud folder) and tells the page which provider. The bridge's
  `read(id, { onCloud })` gets that; an older app never calls it. The 60 s limit stays; when it runs out on a cloud file
  the reason is `cloudTimeout` with the provider, which the page says plainly and lets the person try again.
- Copy in en first, then ko, ja, zh, es, id.

Out: the server's chunk gate (3 chunks at once per server, unchanged), the find-work-files ranking and its dialog's
layout (other work), a bigger chunk size.

## Steps

1. Measure the current upload against qa.trina.app (10 MB and 50 MB, as qa-member).
2. Chunk scheduler in `upload.ts` with unit tests (ordering, retry, a failed chunk, the cap).
3. Desktop: cloud check and provider in `WorkFileSessions`, the event through the preload, `cloudTimeout`.
4. Web: the "Getting … from iCloud" line in the upload row and in Find work files' run, the timeout reason.
5. Measure again, changes fragment, QA row, independent review, PR to dev.

## Risks

- The server reads 3 chunks at once in all (chunk gate) and queues the rest; more requests in flight only wait there.
- Out-of-order chunks make the server hash the rest of the file at complete (it already handles that).
- Memory: at most 6 chunk copies (48 MB) in the page at once, as before.
- No migration, no server API change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, web unit tests for upload and folder upload, desktop
unit tests for work files.

## Result

Built as planned. Changes from the plan: the page's line has 4 places, not 5, and the overtime 2, not 3, so no more
than 6 requests ever go at once (review: HTTP/1.1 opens 6 per host). A cloud download over the minute stays "not tried
again" like any unreadable file, with words that say to open it once and add it again (no new retry path).

Measured from Indonesia to qa.trina.app (PR description): with each request on its own connection (the real
`upload.ts` under Bun) 50 MB went from 7.4 s to 4.2 s (1.75x) and 10 MB from 2.5 s to 1.8 s (1.4x); in Chromium,
where requests share one HTTP/2 or HTTP/3 connection, 1.0-1.2x. 2x is not reached in the browser, and a 10 MB file is
one 8 MB chunk plus 2 MB. The server's running checksum stops after chunk 0 when chunks go at once, so complete hashes
the rest (left for later).
