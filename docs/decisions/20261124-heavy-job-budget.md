# Heavy jobs share one memory budget; the MP4 render's time limit follows the server

- Date: 2026-11-24
- Status: accepted
- Supersedes: the fixed "8 minutes on Linux" limit of [20261123-linux-video-mp4](20261123-linux-video-mp4.md), and,
  on servers of 6 GiB or more, its "encode after drawing" (#526)
- Branch: fix/render-heavy-job-budget (the real-render check of #526, merged in #529, tested at 9100ec9bd)

- **Ask:** two problems from the real-render check of #526.
  - On qa.trina.app (amd64, 2 vCPU, 4 GB), renders with photos took 365–457 s against a fixed 8-minute limit (about
    276 s before #526).
  - On a 4 GiB arm64 box, a render and a LibreOffice conversion at the same time ended in a global OOM in 1 of 4 runs.
    The render leaf was at 972 of 1280 MiB, LibreOffice at 434 MiB in S/conv, and the box had 45 MB free. Each cgroup
    stayed inside its own cap, but the two caps together were more than the box.
- **Rule: one heavy-job budget** (`server/src/system/heavy-jobs.ts`), in the server process. Three kinds of job take it
  before they start and give it back when their processes have ended:
  - the MP4 render (`promo-video/render.ts`; the picture copies are made inside it too);
  - LibreOffice conversions (`files/office-view.ts`);
  - the browser's prints and page views (`files/html-pdf.ts renderSlot`, `tryRenderSlot`).

  How much may run at once:
  - Each job counts its cgroup's cap: the video leaf, all of S/conv for a conversion, PRINT_ONE_MIB for a print.
  - On a server under 6 GiB (the plan's memory or the machine's), one heavy job runs at a time.
  - From 6 GiB, jobs run together while their caps fit the memory minus 3584 MiB.
  - A job alone always runs.

  Order and waiting:
  - First come, first served: a job that waits is never passed by a later one, so no kind starves another, and
    `tryAcquire` never jumps the line.
  - Lock order: print slot first, then the budget. The video takes only the budget, after its own one-at-a-time queue.
    No job holds the budget while it waits for a print slot, so there is no wait cycle. A fresh Opus review checked
    for deadlocks and starvation and found nothing blocking.
  - A print or a conversion waits at most 6 minutes (`HEAVY_WAIT_MAX_MS`), then tells the AI the server is busy. A
    video waits until it gets room, or until the server shuts down.
- **What the person sees:**
  - The video's info gets `mp4.waiting`. The button then says "Waits for another job to finish…" ("다른 작업이 끝나면
    시작해요") instead of "Making the video file…".
  - A failed render gets `mp4.failure` (`too_long`, `memory`, `other`), and the toast says which.
  - `save_promo_video` gives the AI the same reasons. It waits the render's own limit plus 2 minutes.
  - Nothing is dropped silently.
- **Time limit:** 90 s plus 2 core-seconds a frame, for the CPUs the render may use (taskset, at most 2). The waiting
  time does not count. Floors are 8 minutes (Linux) and 4 (Mac); the cap is 30. For 18.5 s at 30 fps that is about 11
  minutes on 2 cores and 20 on 1. qa.trina.app's slowest render (457 s) takes 71 % of it.
- **Streaming encode by headroom:**
  - From 6 GiB the render's leaf is `VIDEO_STREAM_MIB` (1536 MiB) and it encodes while it draws.
  - Below 6 GiB the leaf stays at 1280 MiB and it encodes after drawing, as #526 set it.
  - Measured in this branch on the arm64 VM, the render's exact CLI on a copy of the 48 MP case's work folder:

    | Leaf and encode | Time | Memory the kernel cannot reclaim |
    |---|---|---|
    | 1280 MiB, after drawing | 146–166 s | 963–966 MiB |
    | 1280 MiB, streaming | 123–131 s | 1169–1210 MiB (91–95 %) |
    | 1536 MiB, streaming | 123–127 s | 1087–1144 MiB (71–75 %) |

    Memory is anon+shmem+kernel at its peak.
- **OOM order unchanged:**
  - The render runs at oom_score_adj 900, a print at 900, a converter at 500 (`CONV_OOM_SCORE_ADJ`).
  - The server unit sets no OOMScoreAdjust (0), so the server is the kernel's last choice.
  - `tests/unit/heavy-jobs.test.ts` checks the unit file and these values.
- **Left out:**
  - The other converters in S/conv (whisper for voice input and transcripts, ffmpeg, image helpers, pdftotext, typst,
    pandoc) do not take the budget. They are short or need low latency, and S/conv caps them all together.
  - The render's cap on a 4 GiB VM is not raised.
  - qa.trina.app's config is not changed.
- **Measured** on a private Lima VM: arm64, 2 CPU, 3922 MiB, Debian 13. It ran the 0.17.0 release kit with the default
  package groups and LibreOffice (the office-view group). Its server files (all entry points and migrations) were
  rebuilt with bun 1.3.12, from 9100ec9bd ("before") and from this branch ("after").
  - Each run had 4 renders with photos through `POST /api/promo-videos/:id/mp4`: the #526 fixtures, three 12 MP photos
    with a logo, or three 48 MP photos with a 6 MP logo.
  - Meanwhile, LibreOffice converted a 180-page docx back to back. A scripted API-engine turn (no AI) read its pages
    as images.
  - Results are in the PR.
- **amd64:** not verified on a real amd64 box. This is an estimate from the qa.trina.app numbers.
- **Version impact:** patch.
