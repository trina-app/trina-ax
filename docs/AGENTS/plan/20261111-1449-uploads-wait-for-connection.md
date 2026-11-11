# Uploads wait for the connection, go on by themselves, and never add a "(2)" copy of the same file

- Date (UTC): 2026-11-11 14:49
- Branch: `fix/uploads-wait-for-connection`
- Status: in progress
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
  their 5 tries. A small file to a team folder is now retried the same way (attachments and voice stay one try: a
  second try of those could make a second attachment).
- Server: an upload from the file screen (`POST /api/files/upload`, an upload session to a path) with
  `onExists: 'rename'` whose file is already at that name with the same content (same size and sha256, a regular file
  the person can see and read) keeps that file and answers with it: no "(2)" copy, no new version, no event.
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

(filled in at the end)
