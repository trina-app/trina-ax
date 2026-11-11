# A slow direct download no longer freezes a team server on a Mac

- Date (UTC): 2026-11-11 14:28
- Branch: `fix/slow-download-freeze`
- Status: in progress
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

1. `fileBody(abs, start, size)` in `team-files/download.ts`: on Linux `Bun.file` (sendfile, constant memory) as now;
   elsewhere (macOS) our pull stream over `[start, size-1]`, read on Bun's thread pool in 1 MB pieces, so the JS
   thread never waits in the kernel.
2. `streamFile` (downloads, previews, versions, room files, intro deck, promo video) and `routes/downloads.ts`
   (desktop installers, 110-200 MB, often through the office tunnel) use it for whole files and to-the-end ranges.
3. Comments and DECISIONS C ("Bun 1.3.12 함정") say why and what it costs.

Trade-off on macOS: without backpressure in Bun 1.3.12, the bytes a slow client has not taken yet stay in the server's
memory (at most the file's size per download, freed when it ends or the client leaves). That replaces a freeze of the
whole server. Over TLS it is less than today (Bun read every file whole). The real cure is Bun 1.4 (stream bodies with
backpressure, no `sendfile` on macOS); then this stream needs no change. A Bun upgrade is the release owner's call.

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

(filled in at the end)
