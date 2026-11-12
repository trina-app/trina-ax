# Linux engine firewall: the live check keeps no pass, and Health shows nft errors as one line

- Date (UTC): 2026-11-12 03:07
- Branch: `fix/firewall-no-pass-cache`
- Status: in progress
- Where: trina-ax core (`native/cmd/mycel-launcher`, `native/cmd/mycel-ctl`, `server/src/system/ops.ts`). Why: the
  Linux run base is core (docs/REPOSITORY-RULES.md).
- Version impact: patch (security follow-up to the live firewall check of #543; no API shape, data or migration change).

## Goal (QA TC-310 retest, Ubuntu 24.04)

The launcher kept a passing live firewall probe for 3 seconds, so a turn started within 3 seconds of the last good
probe ran with the nftables table flushed and reached the LAN and metadata listeners. A probe takes well under 25 ms,
so the cache buys nothing. Also, Admin › System › Health showed nft's raw error (the echoed command and its `^^^^^`
marker) in the firewall line.

## Scope

In: probe before every turn (no pass cache, one retry on failure kept, a failure never kept); nft errors become one
plain line in `run/firewall.json` and `mycel-ctl status`, the whole nft answer goes to stderr (the timer's journal);
the server shows only the first line of a firewall reason.
Out: a turn already running when the table disappears keeps running (unchanged from #543).

## Steps

1. `firewallLive`: drop `fwLiveFor` and `okAt`; the mutex alone serialises probes. Rename the unit test to
   `TestFirewallLiveProbesEveryTurn` and check two passes in a row probe twice.
2. `mycel-ctl`: `nftReason` gives nft's first line without "Error:"; "No such file or directory" reads as "table inet
   <id> is not loaded" alone.
3. Server: the Health firewall line cuts the reason to one line (status files written by an older `mycel-ctl`).
4. DECISIONS entry and the #543 plan: the 3-second pass is gone. Changelog fragment.

## Risks

Security: removing the cache only adds probes. Load: one probe (three local TCP connects refused at once) per turn.

## Tests

`go vet` (GOOS=linux), the launcher and mycel-ctl Linux tests in the Linux test image, `go test` for fwprobe,
`bun run typecheck`, the diagnostics unit test, `bun run check:docs`.

## Result

Filled in at the end.
