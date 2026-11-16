# A Linux server unit may use at most 75% of the machine's memory, without swap

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/server-unit-memory-cap (P0 follow-up of fix/tunnel-request-body-memory; QA server measurements 2026-11-16)

- **What broke:** on the Linux QA server (4 GB, no swap) three 100 MB uploads through the Cloudflare tunnel took the
  server's Bun process to 3.3 GB and the whole machine hung. The unit had `MemoryMax=infinity` (a self-install without
  a hosted plan sets no unit limit), so the kernel never ended the server; it thrashed instead. The memory leak itself
  is fixed in its own pull request (branch fix/tunnel-request-body-memory, decision file
  `20261116-tunnel-request-body-memory.md`); this is the safety net
  for the next one.
- **Rule:** `scripts/linux/systemd/server.service.in` has `MemoryMax=75%` and `MemorySwapMax=0`. systemd reads the
  percentage against the machine's RAM (checked with `systemd-analyze verify` on systemd 252, Debian 12). At the limit
  the kernel's cgroup OOM killer ends a process in the unit: print jobs and document converters first (OOM score
  adjustment 900, `server/src/files/html-pdf.ts`, and 500, `server/src/system/cgroups.ts`), else the Bun server. `OOMPolicy=continue` keeps the unit and
  `mycel-bootstrap` starts the server again after 1 s (back-off after more than 5 crashes in 5 minutes; a just-updated
  version that is killed three times before it is healthy is rolled back, as any crash would be). `Restart=always`
  covers the bootstrap.
- **Why 75%:** the server's legitimate memory is the Bun process (the upload chunk gate refuses new chunks above
  max(768 MiB, 35% RAM), `server/src/uploads/chunk-gate.ts`), the converters (at most min(1536 MiB, 25% RAM)) and print
  jobs (the same), all in this unit's cgroup. All three at their maximum at once is about 85% on 4 GB, but it does not
  happen in practice, and the converters and prints are killed first. 75% keeps a quarter of the machine for the
  system, the launcher unit (AI turns), cloudflared and SSH, so the machine stays reachable.
- **Why no MemoryHigh:** near MemoryHigh the kernel throttles the process instead of ending it; the dev environment's
  spike (`server/src/devenv/srt/config.ts`, A21) saw a run held for hours that way. For a leaking server that is the
  same hang this rule is meant to prevent. No swap for the same reason (a server swapping out at the limit hangs too);
  the converter cgroups already have swap 0.
- **No placeholder:** `mycel-ctl update` renders the new templates with the mycel-ctl of the release it updates from
  (`native/cmd/mycel-ctl/install.go` renderUnits), and an unknown `@NAME@` refuses. A literal percentage renders with
  every released renderer.
- **Hosted plans:** `mycel-ctl apply-plan` sets the server unit's MemoryMax / MemoryHigh with `systemctl set-property`
  (a drop-in in `/etc/systemd/system.control`), which takes precedence over the unit file: the hosted MemoryMax and
  MemoryHigh are unchanged. `MemorySwapMax=0` from the unit file does apply there too (apply-plan does not set it):
  on a host with swap, the server is no longer swapped out near its plan limit.
- **How existing servers get it:** the unit template is a root file, so the release that ships it is a root release
  (`scripts/release/publish-server.ts`: needsRoot auto, `rootSince` = that release). The app's own updater refuses it
  (`needs_root`); the root update timer (`mycel-ctl update`, in its window) or `sudo mycel-ctl update` installs it. The
  root step renders the units and runs `daemon-reload` (systemd may apply a changed limit to the running unit then;
  not checked on a real machine), and the app switch restarts `<id>-server.service`, which applies it at the latest. Same on the AMI (same installer and units). Fresh installs render it at once. This is why the cap ships in
  its own pull request: the memory fix itself is app-only and reaches servers through the app's own updater.
- **Not covered:** Docker (no systemd in the image; set the container's memory limit) and office Macs (launchd).
- **Tests:** `tests/unit/g-scripts.test.ts` (the lines, no MemoryHigh, only known placeholders),
  `tests/unit/dev-env-srt.test.ts` (the run template does not copy the server's limits),
  `tests/install/g-linux-install.ts` (`systemctl show`: MemoryMax is a number, swap 0, MemoryHigh infinity).
- **Version impact:** a root release. No data change.
