#!/bin/bash
# Fixtures and Docker runs for the Linux OCR (native/cmd/mycel-ocr, linux-runtime spec 3.7.1 / task L13).
#
#   bash tests/fixtures/ocr/make.sh fixtures --docker   (re)make the committed fixtures below, in a Debian 13 container
#   bash tests/fixtures/ocr/make.sh test --docker       Go test of mycel-ocr + tests/unit/g-ocr-linux.test.ts (server
#                                                       read path through tools/isolate.ts bwrap) in that container
#   bash tests/fixtures/ocr/make.sh bench --docker      spike S5: a 10-page Korean scanned PDF, --cpus 2, time + accuracy
#
# Without --docker the mode runs right here (it must be that image or a Debian 13 with the same packages).
# Fixtures (each well under 200 KB):
#   text.pdf    Korean + English text layer (pango/cairo)       scan.pdf   the same page as an image only (no text layer)
#   mixed.pdf   page 1 text layer, page 2 scanned               many.pdf   3 text pages (for --max-pages)
#   page.png    the page as a grayscale PNG                     trans.png  black pixels, the text only in the alpha channel
#   rot6.jpg    turned 90° left, EXIF Orientation 6             photo.heic tiled (512x512 grid, like a phone photo)
#   enc.pdf     password-protected (user password "secret")    notes.txt  text starting with "BM" (not an image: exit 2)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MODE="${1:-fixtures}"
IMAGE=mycel-ocr-fixtures

if [[ " $* " == *" --docker "* ]]; then
  docker build -q -t "$IMAGE" - >/dev/null <<'EOF'
FROM oven/bun:1.3.12-debian
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
    ffmpeg libheif-examples bubblewrap fonts-nanum pango1.0-tools img2pdf qpdf libimage-exiftool-perl imagemagick \
    libheif-plugin-x265 python3 apparmor && rm -rf /var/lib/apt/lists/*
EOF
  case "$MODE" in
    fixtures)
      docker run --rm -v "$ROOT:/src" -w /src "$IMAGE" bash tests/fixtures/ocr/make.sh fixtures ;;
    test)
      arch=$(docker info --format '{{.Architecture}}'); case "$arch" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac
      out="$ROOT/native/bin/ocr-test"; mkdir -p "$out"
      (cd "$ROOT/native" && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -o "$out/mycel-ocr" ./cmd/mycel-ocr \
        && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go test -c -o "$out/mycel-ocr.test" ./cmd/mycel-ocr)
      # --privileged: tools/isolate.ts runs the converter under bwrap (namespaces); as root here
      docker run --rm --privileged -v "$ROOT:/src" -w /src "$IMAGE" bash tests/fixtures/ocr/make.sh test ;;
    bench)
      arch=$(docker info --format '{{.Architecture}}'); case "$arch" in aarch64|arm64) arch=arm64 ;; *) arch=amd64 ;; esac
      out="$ROOT/native/bin/ocr-test"; mkdir -p "$out"
      (cd "$ROOT/native" && CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -o "$out/mycel-ocr" ./cmd/mycel-ocr)
      docker run --rm --cpus 2 -v "$ROOT:/src" -w /src "$IMAGE" bash tests/fixtures/ocr/make.sh bench ;;
    *) echo "usage: make.sh fixtures|test|bench [--docker]" >&2; exit 2 ;;
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
test)
  bin=/src/native/bin/ocr-test
  (cd /src/native/cmd/mycel-ocr && "$bin/mycel-ocr.test" -test.v -test.count=1)
  # The server's read path: extract.ts -> runIsolated (bwrap) -> mycel-ocr, as an unprivileged account like the
  # server's. Ubuntu hosts (colima, GitHub runners) restrict user namespaces through AppArmor: a profile for a COPY
  # of bwrap at /usr/local/bin (which() looks there before /usr/bin) lets it, without touching a profile another test
  # may hold for /usr/bin/bwrap (linux-runtime spec 3.5.1 step 4 is the production version).
  prof=""
  if [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]]; then
    install -m 755 /usr/bin/bwrap /usr/local/bin/bwrap
    mountpoint -q /sys/kernel/security || mount -t securityfs securityfs /sys/kernel/security
    prof=$(mktemp)
    printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile mycel-ocr-test-bwrap /usr/local/bin/bwrap flags=(unconfined) {\n  userns,\n}\n' > "$prof"
    apparmor_parser -r "$prof"
    trap 'apparmor_parser -R "$prof" || true' EXIT
  fi
  id ocrtest >/dev/null 2>&1 || useradd -r -M -s /usr/sbin/nologin ocrtest
  runuser -u ocrtest -- env HOME=/tmp TMPDIR=/tmp PATH=/usr/local/bin:/usr/bin:/bin MYCEL_NATIVE_BIN=$bin \
    bun test tests/unit/g-ocr-linux.test.ts
  ;;
bench)
  # spike S5: 10 A4 pages of Korean prose (+ some English and numbers) scanned at 200 dpi, recognized with the
  # server's settings (`mycel-ocr --max-pages 50`, OMP_THREAD_LIMIT=1), in a container limited to 2 CPUs.
  T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
  cd "$T"
  python3 - <<'PY'
import random
random.seed(7)
s = ["본 병원은 환자의 개인정보를 소중히 다루며 관련 법령을 지킵니다.",
     "진료 예약은 평일 오전 9시부터 오후 6시까지 전화로 받습니다.",
     "토요일은 오후 1시까지 진료하며 일요일과 공휴일은 쉽니다.",
     "검사 결과는 접수 후 3일 안에 문자 메시지로 알려 드립니다.",
     "보험 청구에 필요한 서류는 원무과에서 발급받을 수 있습니다.",
     "주차는 건물 지하 2층을 이용하시고 2시간까지 무료입니다.",
     "Invoice No. 2026-1021, total amount 152,000 KRW (VAT included).",
     "처방전은 발행일로부터 7일 동안 유효하니 기간 안에 약국에 제출해 주세요.",
     "예약을 바꾸시려면 하루 전까지 연락해 주시기 바랍니다.",
     "치료 계획과 비용은 상담실에서 자세히 설명해 드립니다."]
for p in range(10):
    lines = [f"제{p+1}쪽 안내문"] + [random.choice(s) for _ in range(22)]
    open(f"b{p}.txt", "w").write("\n".join(lines) + "\n")
PY
  for p in 0 1 2 3 4 5 6 7 8 9; do
    pango-view --font="$FONT 11" --margin=56 --width=483 -q -o b$p.pdf b$p.txt
    pdftoppm -r 200 -gray -png -singlefile b$p.pdf s$p
  done
  img2pdf --pagesize A4 -o scan10.pdf s0.png s1.png s2.png s3.png s4.png s5.png s6.png s7.png s8.png s9.png
  cat b0.txt b1.txt b2.txt b3.txt b4.txt b5.txt b6.txt b7.txt b8.txt b9.txt > truth.txt
  echo "scan10.pdf: $(stat -c %s scan10.pdf) bytes, $(pdfinfo scan10.pdf | awk '/Pages/{print $2}') pages, nproc=$(nproc), cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"
  start=$(date +%s.%N)
  /src/native/bin/ocr-test/mycel-ocr --max-pages 50 < scan10.pdf > out.txt
  end=$(date +%s.%N)
  python3 - "$start" "$end" <<'PY'
import sys, difflib, re
t = float(sys.argv[2]) - float(sys.argv[1])
truth = re.sub(r"\s+", "", open("truth.txt").read())
got = re.sub(r"\s+", "", open("out.txt").read())
m = difflib.SequenceMatcher(None, truth, got, autojunk=False)
print(f"S5: {t:.1f} s for 10 pages ({t/10:.1f} s/page); character similarity {m.ratio()*100:.1f}% ({len(got)} of {len(truth)} chars)")
PY
  head -c 600 out.txt; echo
  ;;
*) echo "usage: make.sh fixtures|test|bench [--docker]" >&2; exit 2 ;;
esac
