# A Hangul file sent in a room gets the HWP preview, through the HWP Preview plugin

- Date (UTC): 2026-11-09 10:04
- Branch: `feat/room-hwp-preview`
- Status: done
- Where: trina-ax core (`server/src/files/hwp-preview.ts`, `server/src/rooms/files.ts`, `server/src/routes/rooms.ts`,
  `shared/src/api/`, `web/src/components/`). Why: rooms, files and previews are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new endpoint and a visible change while the HWP Preview plugin is on; none while it is off.
- Builds on: step (f) of `20261109-0939-room-file-viewer.md` (branch `plan/room-file-viewer`); the owner said yes to
  question 5 ("플러그인 기능이면 해").

## Goal

A team file in Hangul (HWP, HWPX) opens as pages in the side panel while the HWP Preview plugin is on. The same file
sent in a team chat room only downloads. With this change a room's Hangul file opens in the panel the same way, from the
same plugin renderer. With the plugin absent or off, nothing changes: the chip downloads, as now.

## Scope

In:
- `GET /api/rooms/:id/files/:fileId/hwp-preview?page=&cacheId=` (`roomFileHwpPreview`), the team route's answer shape.
  Every request (and again after the render) runs the room file's inline-read checks: `RoomFiles.open` (in the room
  now, the message visible to me and not deleted, or my own unsent upload) and the download-only (quarantine) list
  (503 `quarantined`, as the inline read). The bytes come through `SearchAdmission` (no link, no swap, a quarantined
  hash refused) and must be the bytes the file was sent with (its sha256).
- `HwpPreviews` takes a source: the team path (as now) or a room file. One renderer, resolved per request from the
  plugin; one cache (keyed by the room file's id and sha256), the same per-person and per-server limits, isolation and
  invalidation. Plugin off: 503 `unavailable`, reason `disabled`, as for a team file.
- `Me.server.hwpPreview` (the plugin is on and usable here, as `htmlPdf` says the HTML print can run): the room chip
  opens the panel only then, and only within the preview's 20 MB input limit. Otherwise it stays a download.
- Web: `HwpView` takes a team path or a room file; the panel shows it for a room HWP while the preview is on. A
  download-only answer shows the server's notice and the download.
- Security matrix case, `docs:api`, DECISIONS entry, CHANGELOG line.

Out:
- The new room file viewer (plan steps b–e): it reuses this route when it lands.
- HEIC previews of room files.

## Steps

1. `files/hwp-preview.ts`: a source function in place of the team path inside; `page` keeps its signature.
2. `rooms/files.ts` `hwpSource`; `routes/rooms.ts` handler; `shared/src/api/rooms.ts` contract.
3. `Me.server.hwpPreview` (`plugins/manager.ts`, `auth/service.ts`, `shared/src/api/auth.ts`).
4. Web: `lib/preview.ts`, `RoomMessages` `FileChip`, `FilePanel`, `HwpView`; the mock server's `me`.
5. Tests, docs, DECISIONS, CHANGELOG.

## Risks

- Security: a new endpoint that reads room files and runs the converter. It must refuse exactly what the inline read
  refuses, before any render or cache hit, and again after the render. No new unauthenticated URL; the cache id is
  never a capability.
- One render per person and per server is shared with team previews: a room preview can make a team one wait (busy).
- `Me` is read at sign-in: a plugin turned on or off shows in the room after a reload. A stale "on" opens the panel,
  which then says the preview is off (the team file's notice), with the download.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api` and `tests/unit/docs-site.test.ts`; unit `hwp*`,
`c-edit-hwp`, `r4b-office-*`, `b-rooms*` and a new room HWP preview test (member yes; not a member 404; a hidden
message's file, a deleted one, a quarantined one refused; plugin off: disabled; team preview unchanged); the security
route coverage and permission matrix; `test:web`, `build:web`, e2e `room-files-open`, `hwp`, `previews`, `plugins`.

## Result

Built as planned. `GET /api/rooms/:id/files/:fileId/hwp-preview` (`roomFileHwpPreview`) runs `RoomFiles.hwpSource`
(the inline read's checks, the admission read and the sha256 match) before the cache and the render and again after;
`HwpPreviews.pageOf` is the one path for team and room files. `Me.server.hwpPreview` gates the room chip; `HwpView`
takes a team path or a room file and shows the download-only notice. The routes' shared schemas moved to
`shared/src/hwp.ts` (`HwpPreviewQuery`, `HwpPreviewPage`). An independent security review found no must-fix; the cases
it asked to guard are tests. Rebased on dev after `feat/image-viewer` (#246) and `feat/pin-rooms` (#250). PR: #254.
