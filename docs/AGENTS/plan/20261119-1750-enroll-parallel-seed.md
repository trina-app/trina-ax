# First enroll: read the kit seed in parallel before the copy, and stop the data-disk resize udev loop

- Date (UTC): 2026-11-19 17:50
- Branch: `perf/enroll-parallel-seed`
- Status: in progress
- Where: Team AX core (`native/cmd/mycel-enroll/`, `scripts/image/files/`). Why: the hosted server image and its first
  boot program are core.
- Version impact: patch (a faster first boot on hosted servers, no change to what the server does)

## Goal

On a new hosted server (EC2) `mycel-enroll` spends about 245 s in the seed step: one `cp -a` of about 1.5 GB of many
small files from `/usr/lib/mycel/seed-base` (root disk) to the new data disk. The root disk comes from the AMI
snapshot and EBS fills each block from S3 on its first read, so a copy that reads one file at a time waits on S3 for
every block (about 6 MB/s). The team waits for that on its first start.

In the same boot `ax-axdata-resize.service` starts 100-160 times: `resize2fs` opens the data disk for writing, the
close makes udev send a block `change` event (the `watch` option of the disk rules), and `90-axdata-resize.rules`
runs `resize2fs` again.

## Scope

In:

1. Seed: before the `cp -a`, N goroutines walk the seed and read every regular file once (to nothing). This fills
   the EBS blocks with many requests at once; the `cp -a` after it reads blocks that are already on the volume.
   Readers: `AX_ENROLL_SEED_READERS` (default 32, `0` = off). Best effort: a read error is counted and logged, the copy
   still runs and reports real errors. Log lines: start, read-ahead (files, bytes, seconds), copy end (seconds).
2. Seed retry: a marker `BASE/.seed-incomplete` is written before the copy and removed after it. A seed that stopped
   half way (root/VERSION may already be copied) is copied again on the next try instead of being taken as an
   install. Reattach refuses a disk with the marker.
3. udev: a guard script `/usr/local/sbin/axdata-resize DEV` runs `resize2fs` only when the device is at least one
   block group bigger than the file system (dumpe2fs + blockdev, both read-only, so they make no new event). The rule
   and `axdata-grow.service` call it. A real grow (online, or while stopped) still grows.
4. Tests: Go unit tests for the read-ahead (all files, links not followed, a parallel walk) and the seed (tree equal
   with modes, links, hard links, xattrs where the file system has them; retry after a partial copy). A bun unit test
   runs the guard script with fake `dumpe2fs`/`blockdev`/`resize2fs`.

Out: replacing `cp -a` with a Go copier (see Decisions), Fast Snapshot Restore (costs money), changes to the AMI build.

## Steps

1. Plan (this file).
2. `enroll.go` seed: read-ahead, marker, logs; `seed.go` with the parallel reader; tests.
3. `axdata-resize` script, rule, grow service, customize.sh, README; bun test.
4. Checks: `bun run typecheck`, `bun run check:prepush`, `go vet` + `go test ./cmd/mycel-enroll/` on darwin and in a
   Linux container (GNU cp, xattrs).

## Decisions

- Read-ahead + the same `cp -a`, not a parallel Go copy. The slow part is the first read of each block from S3, and an
  EBS block once read stays on the volume (it is not the page cache, so a small machine that drops the cache keeps
  the gain). `cp -a` keeps owners, modes, times, links, hard links, ACLs and xattrs (`security.capability` included)
  in the right order (a `chown` clears file capabilities and set-uid bits, so they must be set after it). A Go copier
  would have to get all of that right again for no extra speed.
- The udev guard compares sizes instead of `OPTIONS+="nowatch"` or `ENV{RESIZE}=="1"`: it ends the loop whatever event
  comes, and it does not change how udev watches the disk for other rules.

## Result

(filled in at the end)
