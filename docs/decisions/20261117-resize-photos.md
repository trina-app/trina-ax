# The AI makes smaller copies of photos: resize_images

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/resize-photos (the owner, "하는게 일반적인거지? 그럼 해"; QA TC-4539 and the rows added with this branch)

Plan: docs/AGENTS/plan/20261117-0300-resize-images.md. Scenario case EDIT-16.

- **Ask:** "이 사진들 크기 줄여줘", "가로 1200픽셀로", "용량 2MB 이하로", "웹용으로 줄여줘". An everyday office task with no
  tool behind it: the AI could only explain that it cannot.
- **Shape:** one new tool, `resize_images`, rather than a mode of make_file (which turns Markdown or CSV into documents)
  or an edit tool (which changes text). It is the photo twin of the PDF tools (`20261116-edit-pdf.md`): existing files in,
  new files out, the same rules. 1-20 photos a call, at most 32 MB each and 200 MB together.
- **Controls, in plain words:** `longest_side` (pixels), `width` (pixels, for "가로 1200"), `max_mb` (the most each copy
  may weigh; may be given with a size), or `preset` instead of numbers: `smaller` = half, `email` = 1600 px and under
  1 MB, `web` = 1920 px and under 500 KB. "2MB" is read as 2,000,000 bytes, so the copy fits either meaning of a
  megabyte. The aspect ratio is kept, a photo is never made larger, and a JPEG's EXIF orientation is applied, so a phone
  photo stays upright. A photo that already meets the ask gets no copy, and the AI says its size.
- **Metadata:** the copy is built from decoded pixels only, so no EXIF, GPS, XMP, ICC profile or comment reaches it. The
  location is always removed (the AI says so). There is no "keep the details" option: nobody asked, and it would need a
  metadata writer. Without the ICC profile, a wide-gamut (Display P3) photo can look slightly less saturated; that is
  accepted for office use.
- **Formats:** JPEG stays JPEG and PNG stays PNG (transparency kept). WebP is read, but Go's x/image has no WebP encoder,
  so its copy is a JPEG, or a PNG when it has see-through pixels, and the AI says so. A WebP can't be replaced in place.
  HEIC is refused in plain words, with the way to save it as JPEG. The bundled library cannot decode it, and the HEIC
  preview converters (heif-dec, macOS ImageIO) are not on every install. GIF, TIFF, BMP and animated PNG or WebP are
  refused too. In a call with several photos, the ones that can't be read are named and the rest are saved.
- **Saving:** a new file "<name>-<word>.<ext>" next to the original (the word in the team's language, "IMG_2041-작게.jpg"),
  or in `output_folder`; `output` names the copy of a single photo. The originals are replaced only with `replace:
  true`, which the prompt allows only when the person explicitly asks, and which needs a read of each photo in this
  turn: a new version, with the old one in its history. Everything else is make_file's path: read access to every photo
  (someone else's file gets the same not-found answer), write access where each copy goes (refused before any work,
  checked again when placed by placeProduced), a conflict copy for an `output` that names a file the AI did not read,
  the wider-audience check (confirmSources) for every copy before any is placed, never into a skill folder, and the
  per-turn write limit. No new card kind. The tool is in SHARED_TOOLS, ROOM_FILE_TOOLS, the guest tools, WRITE_TARGET_ARGS
  (`output`, `output_folder`) and OWN_WORDS_TOOLS.
- **Library and isolation:** no new dependency. The pixels go through the Go helper that already normalizes images for
  AI reads (`mycel-safeops`, new mode `resize`, native/internal/safeops/resize.go). It uses the standard library and
  golang.org/x/image (BSD-3-Clause, already in native/go.mod), is built for Linux and macOS on arm64 and amd64 by
  native/build.sh, and needs no cgo. It runs in the converter isolation (bwrap + converter cgroup on Linux, sandbox-exec
  on macOS) with the image slots of files/vision.ts, 60 s, 1536 MiB and a 48 MB output limit. Not ffmpeg (asked not to),
  not sharp or libvips (a heavy native dependency).
- **Untrusted images:** the declared size is checked before any pixel is decoded: at most 50 megapixels and 65,535 px a
  side, a WebP's lossless frame checked as well (the feat/vision-read review). The scaler halves with a 2×2 box first,
  then uses Catmull-Rom only while its temporary image stays under 384 MiB; a larger mild reduction uses bilinear
  sampling, which keeps none. The helper's arguments are four bounded decimal numbers, checked in the helper and again
  in safeops.Resize. Its refusals are fixed lines, and the server maps them to its own words. The input is read once
  with the quarantine check.
- **Wording:** the result tells the AI each copy's pixel size and file size (and the old ones) and its link by name, and
  that the originals are unchanged and the location was removed. The prompt rule asks for exactly that, in plain words.
- **Left out:** cropping, rotating on request, converting formats on request, HEIC, keeping metadata, folders as input
  (the AI lists the folder and names the photos).
- **Tests:** native/internal/safeops/resize_test.go (sizes, never larger, target size, orientation and GPS, transparency,
  WebP, decompression bombs, refusals), tests/unit/c-resize-images.test.ts (the tool path, names, replace, folder
  rules, lists), the tool-list tests, scenario EDIT-16 (with an `image` check).
- **Version impact:** minor, a new AI tool.
