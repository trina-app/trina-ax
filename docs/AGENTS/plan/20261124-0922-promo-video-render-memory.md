# The promo video's MP4 render stays inside its memory limit

- Date (UTC): 2026-11-24 09:22
- Branch: `fix/promo-video-render-memory`
- Status: done
- Where: server/src/promo-video, server/src/tools/isolate.ts. Why: the Linux render runs in the S/video leaf (1280 MiB);
  a real video must not hit that limit (docs/decisions/20261123-linux-video-mp4.md)
- Version impact: patch: the same MP4, made with less memory; no new setting, no root update

## Goal

A plain text-only promo video already peaked at 86–95% of the render's 1280 MiB cgroup on arm64 test VMs. A real
video has photos (a phone's 12–48 MP pictures) and a logo. Measure that on a real kit, and if it goes over about 85%,
make the render fit for every realistic video, so a person who presses [영상 파일로 받기] gets the file.

## Scope

In:
- Measure on a private Docker QA copy (real kit 0.17.0, `fonts browser video`): text only, three large photos and a
  logo, and the most the tool allows (three 48 MP photos, a 6 MP logo, every line at its longest). Each at least twice,
  through POST /api/promo-videos/:id/mp4.
- Fix what the numbers show, generally (pictures, browser and encoder sizing, CPUs), never per video.
Out:
- A larger cgroup or a different machine-size threshold (VIDEO_MIN_MACHINE_MIB stays 3584).
- Changes to the HyperFrames CLI itself (pinned 0.9.15).

## Steps

1. Build the QA copy, seed the three videos the way the promo_video tool stores them, render each twice, record the
   leaf's memory.peak, anon / shmem / file, time and the result.
2. Pictures: the render's copy of a picture is made at the size a frame needs (short side 1600 px, at most 6 MP) by
   the isolated ffmpeg; a JPEG stays a JPEG, a PNG or WebP becomes a PNG with its transparency. The team file and the
   chat's player are unchanged.
3. The CLI sizes its browser (tile memory, JavaScript heap, frame cache) by the memory it sees, and its encoder threads
   by the CPUs it sees. Inside bwrap it saw the whole machine. Give it the leaf's limits as read-only files at
   /sys/fs/cgroup/memory.max and cpu.max, and run it on two CPUs (taskset, util-linux), as S/video's cpu.max allows.
4. Encode after drawing (PRODUCER_ENABLE_STREAMING_ENCODE=false): the frames go to the work folder (about 400 MB of
   disk for the render's time) and ffmpeg (about 270 MiB with x264) no longer runs next to the browser.
5. A render the kernel killed for memory is recorded and logged as that (memory.events oom_kill).
6. Unit tests; measure again with the fix; typecheck, check:prepush, the promo video tests.

## Decisions

- Fix inside the render, not by a bigger limit: two renders never run at once (one queue), and 1280 MiB must stay what a
  4 GiB server can give next to the app.

## Result

Native arm64 Docker copy of the 0.17.0 kit (2 CPUs, the real S/video leaf, 1280 MiB), through POST
/api/promo-videos/:id/mp4, each case twice. anon+shmem+kernel is what the kernel cannot give back (no swap); the leaf's
memory.peak also counts page cache, which it reclaims under the limit.

| Case | 0.17.0 | With this change |
|---|---|---|
| a text only | 1 done at the limit, 1 over the 8 min limit (busy host); unlimited: 1013 MiB anon+shmem | 2/2 done; 648–699 MiB (51–55 %) |
| b three 12 MP photos + logo | 1 done, 1 OOM; unlimited: 1257 MiB | 2/2 done; 799–856 MiB (62–67 %) |
| c three 48 MP photos + 6 MP logo, longest text | 2/2 OOM in 46–48 s; unlimited: 1465 MiB | 2/2 done; 833–882 MiB (65–69 %) |

amd64 could only run under Rosetta on this Mac (QEMU has no namespaces for bwrap); there node and Chrome take about
300 MiB more anon memory than native, so those numbers overstate a real amd64 server. The same steps cut anon there from
about 1040 to 690–740 MiB.
