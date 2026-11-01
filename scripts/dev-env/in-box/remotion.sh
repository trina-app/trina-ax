# Remotion probe, sent into the box by vm-tests.sh (REMOTION=1): install Remotion, render 5 s of 720p, report time, memory
# and disk. One "remotion: <name> <value>" line per result; the verdict is the last line. Variables at the top of the
# text: CONCURRENCY (Chrome tabs, 0 = Remotion's own default), FRAMES (150 = 5 s), VERSION. /work/node_modules is the box
# volume.
: "${CONCURRENCY:=1}" "${FRAMES:=150}" "${VERSION:=4.0.539}"
cd /work || exit 1
now() { date +%s.%N; }
took() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }
mkdir -p src out /cache/tmp
cat > package.json <<JSON
{"name":"render-test","private":true,"dependencies":{"remotion":"$VERSION","@remotion/cli":"$VERSION","react":"19.2.0","react-dom":"19.2.0"}}
JSON
cat > src/index.ts <<'TS'
import { registerRoot } from 'remotion'
import { Root } from './Root'
registerRoot(Root)
TS
echo "export const FRAMES = $FRAMES" > src/frames.ts
cat > src/Root.tsx <<'TSX'
import React from 'react'
import { FRAMES } from './frames'
import { AbsoluteFill, Composition, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
const Scene: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const pop = spring({ frame, fps, config: { damping: 12 } })
  const hue = interpolate(frame, [0, FRAMES], [200, 320])
  return (
    <AbsoluteFill style={{ background: `linear-gradient(${frame * 2}deg, hsl(${hue},70%,35%), hsl(${hue + 60},70%,20%))`, alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', color: 'white' }}>
      <svg width="1280" height="720" style={{ position: 'absolute' }}>
        {Array.from({ length: 24 }, (_, i) => <circle key={i} r={18 + i} fill="white" opacity={0.12} cx={640 + 420 * Math.cos(i + frame / 25)} cy={360 + 240 * Math.sin(i * 2 + frame / 25)} />)}
      </svg>
      <div style={{ fontSize: 96, fontWeight: 700, transform: `scale(${pop})` }}>개발 환경 Remotion</div>
      <div style={{ fontSize: 40, opacity: interpolate(frame, [30, 60], [0, 1], { extrapolateRight: 'clamp', extrapolateLeft: 'clamp' }) }}>720p · 5 s · frame {frame}</div>
    </AbsoluteFill>
  )
}
export const Root: React.FC = () => <Composition id="Main" component={Scene} durationInFrames={FRAMES} fps={30} width={1280} height={720} />
TSX

# the sampler: memory the kernel cannot give back (anon + shmem, which holds /tmp and /dev/shm), all charged memory
# (with file cache), and the use of /tmp. memory.peak alone would keep the memory bomb of the limit tests.
cg=/sys/fs/cgroup
oom0=$(awk '$1=="oom_kill"{print $2}' $cg/memory.events 2>/dev/null)
( while :; do
    a=$(awk '$1=="anon"||$1=="shmem"{s+=$2} END{print int(s/1048576)}' $cg/memory.stat 2>/dev/null)
    c=$(( $(cat $cg/memory.current 2>/dev/null || echo 0) / 1048576 ))
    t=$(df -m --output=used /tmp | tail -1)
    p=$(cat $cg/pids.current 2>/dev/null || echo 0)
    echo "${a:-0} $c $t $p"; sleep 0.25
  done > /cache/mem.samples ) &
sampler=$!

t0=$(now); npm install --no-audit --no-fund --loglevel=error > /cache/remotion-install.log 2>&1; rc=$?; t1=$(now)
echo "remotion: install_seconds $(took "$t0" "$t1") (exit $rc)"
[ $rc -eq 0 ] || tail -5 /cache/remotion-install.log
npx --no-install remotion browser ensure > /cache/remotion-browser.log 2>&1; rc=$?; t2=$(now)
echo "remotion: browser_seconds $(took "$t1" "$t2") (exit $rc)"
[ $rc -eq 0 ] || tail -5 /cache/remotion-browser.log
chrome=$(find node_modules/.remotion -type f -name 'chrome-headless-shell' 2>/dev/null | head -1)
if [ -n "$chrome" ]; then
  missing=$(ldd "$chrome" 2>/dev/null | awk '/not found/{print $1}' | sort -u | tr '\n' ' ')
  echo "remotion: chrome_missing_libraries ${missing:-none}"
fi
echo "remotion: fonts_with_hangul $(fc-list :lang=ko family 2>/dev/null | wc -l) (fc-list: $(command -v fc-list || echo absent))"

c=(); [ "$CONCURRENCY" = 0 ] || c=(--concurrency="$CONCURRENCY")
t3=$(now); mark=$(wc -l < /cache/mem.samples)
npx --no-install remotion render src/index.ts Main out/video.mp4 --log=verbose "${c[@]}" > /cache/remotion-render.log 2>&1; rc=$?
t4=$(now)
echo "remotion: render_seconds $(took "$t3" "$t4") (exit $rc, concurrency ${CONCURRENCY/#0/default})"
[ $rc -eq 0 ] || tail -12 /cache/remotion-render.log
echo "remotion: chrome_tabs $(grep -i -m1 -E 'concurrency|parallelism' /cache/remotion-render.log | cut -c1-120)"
kill $sampler 2>/dev/null; wait $sampler 2>/dev/null

awk -v m="$mark" 'NR<=m{if($1>i)i=$1} NR>m{if($1>a)a=$1; if($2>c)c=$2; if($3>t)t=$3; if($4>p)p=$4}
  END{printf "remotion: install_peak_unreclaimable_mib %d\nremotion: render_peak_unreclaimable_mib %d\nremotion: render_peak_charged_mib %d\nremotion: render_peak_tmp_mib %d\nremotion: render_peak_pids %d\n", i, a, c, t, p}' /cache/mem.samples
oom1=$(awk '$1=="oom_kill"{print $2}' $cg/memory.events 2>/dev/null)
oom=$(( ${oom1:-0} - ${oom0:-0} ))
echo "remotion: oom_kills $oom"
echo "remotion: disk_mib node_modules $(du -sm node_modules | cut -f1), cache $(du -sm /cache | cut -f1), output $(du -sm out | cut -f1)"
probe=$(npx --no-install remotion ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames -show_entries format=duration -of csv=p=0 out/video.mp4 2>/dev/null | tr '\n' ' ')
echo "remotion: video $probe"
case "$rc:$oom:$probe" in
  0:0:*1280,720*) echo "remotion: result ok" ;;
  *) echo "remotion: result failed"; exit 1 ;;
esac
