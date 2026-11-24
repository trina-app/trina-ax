# The promo video's MP4 render stays inside its memory limit

- Date (UTC): 2026-11-24 09:22
- Branch: `fix/promo-video-render-memory`
- Status: in progress
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
4. Unit tests; measure again with the fix; typecheck, check:prepush, the promo video tests.

## Decisions

- Fix inside the render, not by a bigger limit: two renders never run at once (one queue), and 1280 MiB must stay what a
  4 GiB server can give next to the app.

## Result

(filled in at the end)
