# Uploads wait for the connection, go on by themselves, and never add a "(2)" copy of the same file

- Date (UTC): 2026-11-11 14:49
- Branch: `fix/uploads-wait-for-connection`
- Status: done
- Where: trina-ax core (`web/src/lib/upload.ts`, `web/src/components/FileUploads.tsx`,
  `web/src/components/FolderUploads.tsx`, `web/src/pages/Files.tsx`, `server/src/team-files/service.ts`,
  `server/src/routes/files.ts`, `server/src/uploads/sessions.ts`, five locales, tests). Why: uploads and the file
  screen are core (see docs/REPOSITORY-RULES.md).
- Version impact: patch, uploads survive a network drop and an identical file is not stored twice; no API shape,
  data or migration change

## Goal

QA TC-223 (from TC-033 and TC-049). (1) A 1 GB upload with the network off for 2 minutes at about 40%: after about
15 s the row says "팀 서버에 연결하지 못했어요…" and stays failed when the network is back; the row has only ✕
(`withRetry` gives up after 5 tries, 1+2+4+8 s; a failed row has no retry). Picking the file again goes on from about
40% (the server keeps the chunks), but nothing says so. (2) At 390 px, 30 photos with the network off for 30 s
halfway: 12 stayed failed (a small file is sent once, with no retry at all); picking the photos again made 18
"(2)" copies of the ones that had arrived (`onExists: 'rename'`), and the folder upload's 다시 시도 button is pushed
off the row at phone width.

After this change an upload that loses the connection waits for it ("연결을 기다리고 있어요") and goes on by itself
when it is back; a failed file has 다시 시도, which continues from what the server has; and the same file uploaded
again into the same place (a retry whose first answer was lost, or the photos picked again) is not stored twice.

## Scope

In:
- `lib/upload.ts`: a request that fails because the connection is gone (a network error, or 502 / 504 from the
  relay) waits for the browser's `online` event or a growing pause (up to 10 s) and tries again, for up to
  10 minutes, then fails as before. While it waits the upload reports the phase `waiting`. Other server errors keep
  their 5 tries. A small file to a team folder is now sent again after a lost connection (a server error still ends it at
  once, as before; attachments and voice stay one try: a second try of those could make a second attachment).
- Server: an upload from the file screen (`POST /api/files/upload`, an upload session to a path) with
  `onExists: 'rename'` whose file is already at that name (or a renamed form) as **this person's own upload of the same
  content in the last 24 hours** keeps that file and answers with it: no "(2)" copy, no new version, no event. Someone
  else's file, a file made another way or an older upload of the same content gets "(2)" as before (review 11-12).
- `FileUploads`: a failed row has 다시 시도 (the same file again: a large one goes on from the chunks the server has);
  a waiting row says so and keeps its bar.
- `FolderUploads`: at phone width the counts go under the name so 다시 시도 and ✕ stay on the row.
- Five locales; unit tests (web upload, file rows, server upload).

Out: chat attachments and voice (their own retry rules); a request that hangs without an error (the place-in-line
idle rule already lets others go on); uploads after a page reload (the picked file is gone, as before).

## Steps

1. Server `placeUpload` option `keepSame`, passed by the small upload route and an upload session's completion.
2. `withRetry`: waiting for the connection, the `waiting` phase; small path uploads use it.
3. `FileUploads` retry and waiting words; `Files.tsx` keeps what a retry needs; `FolderUploads` phone row.
4. Tests; check on a local server: a ≤500 MB file with the browser offline for 2 minutes, and 30 small files at
   390 px offline for 30 s, then picked again.

## Risks

No migration, no permission change: the identical-file check reads only a file the person can see and read (a hidden
one is treated as before, so nothing new about it shows). A file uploaded twice on purpose into the same folder with
the same name and content now stays one file (it was an exact "(2)" copy before). An upload left offline for longer
than 10 minutes still fails, now with 다시 시도. Phone and computer use the same rows.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/c-uploads.test.ts` and the new server
test, `bun run test:web` (upload, file rows, folder upload).

## Result

Built as planned, with two changes found on the way.

- `withRetry` waits only for a lost connection: a `TypeError` with the browsers' network-failure words (no answer;
  lib/xhr.ts gives "Network request failed"), any TypeError while the browser is offline, or the relay's 502 / 504. Other non-API errors are not retried any more: a file that cannot be read (a `DOMException`) or an
  answer that is not what was asked for (a parse error) is not made better by sending again (the existing tests
  "a file that cannot be read fails at once" and "a watched upload keeps the client's contract" caught this). A small
  file's server error stays one try (the onboarding page's "a failed upload is retried" test expects the row to fail
  and offer its own retry).
- The identical-file check looks at the name and at its renamed forms up to the first free one ("IMG_0001 (2).jpg"):
  on the local server, a folder that already had another file named IMG_0001.jpg got "(2)" on the first try and
  "(3)" when the same photo was sent again.

Tests: `web/test/unit/upload-wait.test.ts` (a small file waits and is sent again; a large file waits on its chunk,
with the relay's 502 counted as lost; offline: no request until the `online` event; the time limit; a refusal and a
small file's 500 are one try; an attachment is one try; the waiting words and bar), `web/test/unit/
file-upload-retry.test.tsx` (다시 시도 on a failed row only; a waiting row's words and bar),
`tests/unit/c-uploads-same.test.ts` (small and session uploads kept once, no version or event; another file gets
"(2)"; a retry after "(2)" is kept there; a folder of the name; fail and replace unchanged). The session test in
`c-uploads.test.ts` now sends another file for its "(2)" case.

Local server (Chromium, CDP network emulation): a 200 MB file throttled to 6 MB/s, offline for 2 minutes at 40%:
"연결을 기다리는 중" with the bar kept, done 1 s after the network came back, one file, same bytes. 30 photos of
300 KB at 390 px, throttled, offline for 30 s after 12 had arrived: no row failed, all 30 arrived once (the 3 that
were in flight when the network went had arrived; their retries were kept, no "(2)"); the 30 picked again: still 30
files, no copy. A folder upload with two files refused at 390 px: 다시 시도 and ✕ on the row inside the screen, the
counts on a line below; 다시 시도 finished 6 of 6. A single file refused once at 390 px: 다시 시도 on the row, then
done, one file.

Review 11-12 (independent review of the held PR), two narrowings, rebased onto dev 1ccf9a7f6:
- The kept file was any readable file with the same content at the name or "(2)".."(20)", however old: someone
  uploading a team template again to get their own copy got the shared original back, then edited it. Now only this
  person's own upload of that content in the last 24 hours is kept (a file_events `upload` row of theirs for that path
  and sha256; the file still that content). The QA cases stay covered: a resumed upload, photos picked again.
  `c-uploads-same.test.ts`: the same content uploaded by bob, then by alice gets "(2)" (and alice's own copy sent again
  is kept); a file written another way gets "(2)"; alice's own upload from 25 hours ago gets "(2)".
- Any TypeError counted as a lost connection, so a fault in the page would have been retried silently for 10 minutes.
  Now only the browsers' network-failure words (Chromium "Failed to fetch", WebKit "Load failed" and its two offline
  phrasings, Firefox "NetworkError when attempting to fetch resource.", xhr.ts "Network request failed"), or a TypeError
  while the browser is offline. `upload-wait.test.ts`: a page fault fails at once after one try.
- DECISIONS.md: "Uploads wait for the connection; one's own upload sent again is kept once".
