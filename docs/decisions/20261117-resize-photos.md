# The AI makes smaller copies of photos: resize_images

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/resize-photos (the owner, "하는게 일반적인거지? 그럼 해"; QA TC-4539 and the rows added with this branch);
  feat/photos-heic-keep-meta (the owner, 2026-11-17: "왜 위치 정보를 빼? 아이폰 HEIC는 지원안해?": details kept, HEIC in)

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
- **Metadata (changed 2026-11-17 by the owner: "왜 위치 정보를 빼?"):** the copy keeps its photo's details by default:
  the EXIF (time taken, camera, location), the XMP and the ICC colour profile, carried from JPEG, PNG and WebP into the
  JPEG or PNG copy (native/internal/safeops/meta.go). They are edited in place, so maker-note offsets stay right: the
  orientation is reset to 1 because the pixels are turned upright (also `tiff:Orientation` in the XMP), the EXIF pixel
  size is the copy's, and the EXIF thumbnail (the old picture, not turned) is left out. Comments and other segments are
  not carried. `remove_details: "location"` ("위치 정보 빼고"), only when the person asks: the GPS IFD and the values
  it points to are zeroed and its pointer leaves IFD0, and the XMP (which can hold GPS too) is left out; `"all"`: no
  EXIF, XMP or ICC. A block that is not a TIFF the code can check is left out rather than copied unchecked. The helper
  reports what happened (`resize: details=… location=…` on stderr), so the AI says "the location was removed" only
  when one was, "it had no location" when there was none, and nothing about details by default. The details count
  toward a `max_mb` target. Keeping the ICC profile also fixes the less saturated Display P3 copies.
- **Formats:** JPEG stays JPEG and PNG stays PNG (transparency kept). WebP is read, but Go's x/image has no WebP encoder,
  so its copy is a JPEG, or a PNG when it has see-through pixels, and the AI says so. `format: "jpeg" | "png"` when the
  person names one (a copy is then made even at the same size). A WebP or HEIC can't be replaced in place. GIF, TIFF,
  BMP and animated PNG or WebP are refused. In a call with several photos, the ones that can't be read are named and
  the rest are saved.
- **HEIC (added 2026-11-17, the owner: "아이폰 HEIC는 지원안해?"):** the iPhone's default format, so the most common
  company photo. The copy is a JPEG (or the format named), and the AI says so. Decoders: the ones the file panel
  preview and AI reads already use (files/heic-preview.ts), each in the converter isolation with 30 s and 1536 MiB.
  - Linux servers: libheif's `heif-dec` (`heif-convert` before 1.17) from Debian's `libheif-examples`, already in
    scripts/system/packages.json (group `documents`, install `always`, floor 1.15.1), so every server has it and
    `mycel-ctl update` keeps it (packages.sh sync). Debian 13 ships it for amd64 and arm64 (1.19.8, 1.23.6 in
    trixie updates); checked in Docker: it writes the EXIF with the orientation reset. libheif is LGPL-3.0+, the
    example programs are MIT (Expat); it runs as a separate program, nothing is linked. No new package; libvips was
    not taken (larger, and not needed). Debian 12's heif-convert 1.15 turns the pixels but keeps orientation 6, so the
    server always tells the Go helper the pixels are upright (option bit 16; `vision upright` for AI reads), which
    also fixes a double turn of HEIC photos in AI reads on Debian 12.
  - macOS (office Mac, desktop dev): `mycel-ocr --jpeg N --meta` (Apple ImageIO, the decoder sips uses) at quality
    0.92, with the EXIF, GPS, TIFF and IPTC properties and orientation 1. Not `sips`: inside the sandbox it fails
    writing to the per-user temp folder ("Error 13", checked 2026-11-17, also with TMPDIR set to the work folder).
  - Windows: no HEIC decoder (no server path there has one); the plain sentence below.
  - Before any decoder runs, the size the file declares is read from the box headers (heicSize: the `ispe` of the
    primary item, and the largest of every image item, since heif-dec decodes every top-level image): over 50
    megapixels or 65,535 px a side is refused undecoded, no primary size is "damaged". The decoded JPEG then goes
    through the Go helper's own pixel checks. A file with several top-level images uses `out-1.jpg`, the primary one
    in phone photos (as the preview does).
  - No decoder on an install: one plain sentence, "이 서버에서는 아이폰 사진(HEIC)을 열 수 없어요. JPEG로 저장해서 다시
    올려 주세요" (`vision_no_heic` / VISION_TEXT.noHeic for reads; the same words asked of the AI for resize_images).
  - Previews (the owner's screenshot, 2026-11-17: the AI read a HEIC on potenlab.trina.app, but the app showed no
    picture). The file viewer already showed the server's JPEG (GET /api/files/preview). The gaps were the
    attachment squares and thumbnails: makeThumbnail used ffmpeg, which decodes only a phone HEIC's first tile or
    nothing, and the message box drew the local bytes, which Chrome cannot. Now makeThumbnail (uploads/image.ts) sends
    a HEIC (known by name or, for room and chat files stored without a name, by its `ftyp` brand) through the same
    size check and decoder, then `mycel-safeops resize` (no details, JPEG, upright); the chat and room message boxes
    show that thumbnail once the photo is uploaded (ChipThumb isHeicName), and a picture icon when none could be made.
    The Files list shows icons, not thumbnails, for every image, so nothing changes there.
  - The AI sees HEIC (this already worked on Linux 0.5.12: the engine's own Read is denied, engine/claude.ts, and our
    read converts through files/vision.ts modelImage with the same decoders): Claude's image input takes only JPEG, PNG, GIF and WebP (platform.claude.com vision docs,
    checked 2026-11-17), and every read path (read, chat_file, room_file, Drive and mail attachments) already converts
    through modelImage; it now checks the declared size first and has the plain no-decoder sentence.
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
  that the originals are unchanged, and what happened to the details (nothing said by default; "removed" only when it
  was). The prompt rule asks for exactly that, in plain words.
- **Left out:** cropping, rotating on request, a format change without a size change, folders as input
  (the AI lists the folder and names the photos).
- **Tests:** native/internal/safeops/resize_test.go (sizes, never larger, target size, orientation, transparency,
  WebP, decompression bombs, refusals), meta_test.go (details kept, location removed, all removed, PNG, upright,
  target size with details, hostile EXIF), tests/unit/c-photos-heic.test.ts (HEIC resize, AI read of HEIC, declared
  size, no decoder; fixture tests/fixtures/exif/photo-gps.heic made with sips from photo-gps.jpg), tests/unit/c-resize-images.test.ts (the tool path, names, replace, folder
  rules, lists), the tool-list tests, scenario EDIT-16 (with an `image` check).
- **Version impact:** minor, a new AI tool.
