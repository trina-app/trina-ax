#!/bin/bash
# Fixtures of scanned PDFs and photos (AI reads show them as images, server/src/files/vision.ts; macOS indexes scanned
# PDFs with Apple Vision, tests/unit/ocr.test.ts). Linux has no OCR any more (docs/DECISIONS.md "AI sees images and PDF
# pages"), so this script only makes the fixtures.
#
#   bash tests/fixtures/ocr/make.sh fixtures --docker   (re)make the committed fixtures below, in a Debian 13 container
#
# Without --docker it runs right here (it must be that image or a Debian 13 with the same packages).
# Fixtures (each well under 200 KB):
#   text.pdf    Korean + English text layer (pango/cairo)       scan.pdf   the same page as an image only (no text layer)
#   mixed.pdf   page 1 text layer, page 2 scanned               many.pdf   3 text pages (for --max-pages)
#   page.png    the page as a grayscale PNG                     trans.png  black pixels, the text only in the alpha channel
#   rot6.jpg    turned 90° left, EXIF Orientation 6             photo.heic tiled (512x512 grid, like a phone photo)
#   enc.pdf     password-protected (user password "secret")    notes.txt  text starting with "BM" (not an image)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MODE="${1:-fixtures}"
IMAGE=mycel-image-fixtures

if [[ " $* " == *" --docker "* ]]; then
  docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM oven/bun:1.3.12-debian
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils libheif-examples fonts-nanum pango1.0-tools \
    img2pdf qpdf libimage-exiftool-perl imagemagick libheif-plugin-x265 && rm -rf /var/lib/apt/lists/*
EOF
  case "$MODE" in
    fixtures) docker run --rm -v "$ROOT:/src" -w /src "$IMAGE" bash tests/fixtures/ocr/make.sh fixtures ;;
    *) echo "usage: make.sh fixtures [--docker]" >&2; exit 2 ;;
  esac
  exit
fi

FONT="NanumGothic"
page_text() {
  printf '%s\n' "진료 예약 안내" "평일 오전 9시부터 오후 6시까지 받습니다" "Invoice 2026-10-21 total 15000"
}

case "$MODE" in
fixtures)
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  cd "$T"
  page_text > note.txt
  pango-view --font="$FONT 16" --margin=40 --width=600 -q -o text.pdf note.txt
  pdftoppm -r 150 -gray -png -singlefile text.pdf page
  magick page.png -strip -define png:compression-level=9 page.png
  img2pdf --pagesize 'A5^T' --fit into -o scan.pdf page.png 2>/dev/null || img2pdf -o scan.pdf page.png
  pdfunite text.pdf scan.pdf mixed.pdf
  for i in 1 2 3; do printf 'Page %s of the long document\n문서의 %s쪽입니다. 이 쪽에는 글자 층이 있습니다.\n' "$i" "$i" > p$i.txt
    pango-view --font="$FONT 14" --margin=30 --width=500 -q -o p$i.pdf p$i.txt; done
  pdfunite p1.pdf p2.pdf p3.pdf many.pdf
  # the worst transparency case: every pixel black, the text only in the alpha channel
  magick page.png -negate -alpha copy -fill black -colorize 100 -strip trans.png
  magick page.png -rotate -90 -quality 75 -strip rot6.jpg
  exiftool -q -n -Orientation=6 -overwrite_original rot6.jpg
  magick page.png -resize 150% big.png
  heif-enc -q 50 --cut-tiles 512 -o photo.heic big.png >/dev/null
  qpdf --encrypt secret owner 256 -- text.pdf enc.pdf
  printf 'BM 정비 기록\n엔진오일 교체 2026-10-01\n' > notes.txt
  for f in text.pdf scan.pdf mixed.pdf many.pdf page.png trans.png rot6.jpg photo.heic enc.pdf notes.txt; do
    cp "$f" "$HERE/$f"; printf '%-11s %7d bytes\n' "$f" "$(stat -c %s "$f")"
  done
  ;;
*) echo "usage: make.sh fixtures [--docker]" >&2; exit 2 ;;
esac
