# Heavy jobs share one memory budget; the MP4 render's time limit follows the server

- Date (UTC): 2026-11-24 14:43
- Branch: `fix/render-heavy-job-budget`
- Status: in progress
- Where: server (promo-video/render.ts, files/html-pdf.ts, files/office-view.ts, a new system/heavy-jobs.ts), shared
  API (an optional field), web (the MP4 button's words). Why: the real-render check of #526 (#529).
- Version impact: patch. No new feature; renders and conversions that failed now finish or wait.

## Goal

Two problems from the real-render check of #526 at 9100ec9bd:

1. On qa.trina.app (amd64, 2 vCPU, 4 GB) renders with photos took 365–457 s against a fixed 8-minute limit (about
   276 s before #526). A slower server, or a longer video, fails at the limit with no reason given.
2. On a 4 GiB arm64 box with all package groups, a render and a LibreOffice conversion at the same time ended in a
   global OOM in 1 of 4 runs (render leaf 972 of 1280 MiB, LibreOffice 434 MiB in S/conv, the VM's free memory 45 MB).
   Each cgroup was inside its own cap; together they were more than the box.

## Scope

In:
- One heavy-job budget for the server process (system/heavy-jobs.ts), sized from the plan's or the machine's memory.
  The MP4 render, LibreOffice conversions (office-view.ts) and the browser prints (html-pdf.ts renderSlot /
  tryRenderSlot) take it. Under 6 GiB one heavy job runs at a time; above, jobs run together while their memory caps
  fit the budget. First come, first served (no job passes one that waits: no starvation). Lock order: print slot,
  then heavy budget; the video takes only the budget (no cycle, no deadlock).
- The video panel says honestly when its render waits for another job ("Waits for another job to finish…",
  "다른 작업이 끝나면 시작해요"), and why a render failed (too long, out of memory, other).
- The render's time limit from the CPUs it may use and the video's frames instead of a fixed 8 minutes.
- Find out what #526 changed in speed (streaming encode off, taskset, picture shrink) on a real 2 CPU VM, and fix
  what costs time without raising the memory of a render.
Out: raising the render's memory cap, changing qa.trina.app's config, the print queue's own limits.

## Steps

1. Plan (this file).
2. system/heavy-jobs.ts + tests (budget, waiting, order, abort, try).
3. Render: take the budget, waiting state, time limit, failure kind; office and print take the budget.
4. Measure on a private Lima VM (arm64, 2 CPU, 4 GiB, the default groups): 4 renders with photos while LibreOffice
   converts a large docx back to back; times and OOMs before and after.
5. Gate on the Mac mini, a fresh review, PR.

## Decisions

docs/decisions/20261124-heavy-job-budget.md (new).

## Risks

A print or a page view waits behind a running video (up to its limit); it tells the AI the server is busy after the
wait limit instead of starting. oom_score_adj stays: heavy jobs 500–900, the server 0.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, b-promo-video, office and
isolate area tests, a new heavy-jobs test.

## Result

(at the end)
