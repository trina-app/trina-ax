# A slow direct download no longer freezes a team server on a Mac

- Date (UTC): 2026-11-11 14:28
- Branch: `fix/slow-download-freeze`
- Status: done (PR open)
- Where: trina-ax core (`server/src/team-files/download.ts`, `server/src/routes/downloads.ts`; tests; DECISIONS C).
  Why: the file download path of the core, used by every edition.
- Version impact: patch; no API or data change (same status codes, headers and bytes)

## Goal

QA TC-222 (P1): a member downloading a big team file slowly, straight from the server's own port (LAN, the office
Mac's address, the office public address), froze the whole server for everyone: `/api/health` stopped answering, the
relay marked the team offline. Through the relay the same download was fine. After this change the slow client gets
its bytes slowly and everyone else is served normally.

## Cause (confirmed on macOS, Bun 1.3.12)

- A whole-file download returns `new Response(Bun.file(path))`. Bun.serve sends that body with `sendfile(2)` on the
  server's only JS thread (`RequestContext.onSendfile`).
- XNU's `sendfile` allocates its buffers with `M_WAIT` and reads the file into them *before* it looks at the socket's
  non-blocking flag (`bsd/kern/uipc_syscalls.c`). A file that is not in memory plus a slow reader parks the thread in
  the kernel, uninterruptibly. Reproduced: 900 MB file written with `F_NOCACHE`, `curl --limit-rate 1M` on the direct
  port for 25 s; the client got 0 bytes, `/api/health` timed out for 352 s, `sample` showed the main thread in
  `sendfile`, process state `U`. The same file warm, or a fast client, did not freeze. Bun itself stopped using
  `sendfile` on macOS for this reason (oven-sh/bun#33728, Bun 1.4).
- Linux's `sendfile` honours `O_NONBLOCK` (returns `EAGAIN` when the socket is full), so Linux servers keep it.
- Bun 1.3.12 has no backpressure for any stream body (measured, 400 MB file, 1 MB/s client for 10 s: pull stream
  778 MB RSS, direct stream 469 MB, async generator 329 MB, `Bun.file().stream()` 1 GB, a spawned `cat` 907 MB).
  Over TLS (the office Mac's LAN listener) Bun reads a `Bun.file` body whole into memory (400 MB file: +340 MB even
  for a fast client).

## Change

1. `fileBody(abs, start, size)` in `team-files/download.ts`: on Linux `Bun.file` (sendfile, constant memory) as now.
   Elsewhere (macOS) never sendfile: a file up to 256 MB (`WHOLE_MAX`) is read whole on Bun's thread pool and sent
   from memory, which keeps its Content-Length (Bun 1.3.12 drops the Content-Length of a stream body and sends it
   chunked; this is what Bun already did for a `Bun.file` body over TLS, the office Mac's LAN listener); a bigger file
   goes as our pull stream in 1 MB pieces. The JS thread never waits in the kernel.
2. `streamFile` (downloads, previews, versions, room files, intro deck, promo video) and `routes/downloads.ts`
   (desktop installers, 110-200 MB, often through the office tunnel) use it for whole files and to-the-end ranges.
   Both are async now (callers already await them; tests of `serveDownload` too).
3. Comments and DECISIONS C ("Bun 1.3.12 함정") say why and what it costs.

Trade-off on macOS: without backpressure in Bun 1.3.12, the bytes a slow client has not taken yet stay in the server's
memory (at most the file's size per download, freed when it ends or the client leaves); files over 256 MB go chunked
on a direct connection (no size in the browser's download list; through the relay the size is kept). That replaces a
freeze of the whole server. The real cure is Bun 1.4 (stream bodies with backpressure, no `sendfile` on macOS); then
the stream needs no change. A Bun upgrade is the release owner's call.

Out: `web-static.ts` (app files, a few MB, read on every page load so in memory) keeps `Bun.file`; noted in the PR.

## Steps

1. Reproduce on a local dev server (macOS): cold 900 MB file, slow direct download, probe `/api/health`.
2. `fileBody` + use it in `streamFile` and `downloads.ts`; comments; DECISIONS.
3. Unit tests: `fileBody` returns exact bytes for whole files and tails, both modes; `streamFile` on macOS answers a
   whole file with a stream (same headers and bytes); downloads route unchanged.
4. Verify again with the reproducer: health stays fast during and after the slow download; a fast download stays fast
   (speed and sha256); through the relay unchanged.

## Risks

No migration, no API change. Linux unchanged. macOS: memory as above; throughput of the stream measured against
`sendfile`.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/<download tests>`.

## Result

Built as in Change. Differences from the first plan: a pure stream lost the Content-Length on direct connections
(found by the new test), so files up to 256 MB are read whole instead.

Checked on a local dev server (macOS, Bun 1.3.12):
- Before (earlier in the day, a Mac under memory pressure): cold 900 MB file, `curl --limit-rate 1M` direct for 25 s:
  the client got 0 bytes, `/api/health` timed out for 352 s, the main thread sat in `sendfile`. After the reboot the
  same run no longer froze the unchanged server (the trigger needs the kernel short of memory), so the "after" below
  shows the new path works, not a fresh fail-before.
- After: the same slow download of a new cold 900 MB file: 26 MB in 25 s, 75 health probes, max 181 ms; server memory
  peaked at 964 MB and went back to 80 MB when the client left. Fast direct downloads: 900 MB in 1.1 s (chunked),
  400 MB in 0.5 s, 200 MB in 0.27 s with Content-Length; sha256 equal. Through the relay: Content-Length kept, sha256
  equal, a 1 MB/s download kept the server at 56-123 MB. HEAD keeps Content-Length.
- Unit: `tests/unit/file-body.test.ts` (new) and the 53 test files that touch the download routes: 1046 pass.
