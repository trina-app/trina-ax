# Linux engine firewall: every turn checks the live rules, not only the status file

- Date (UTC): 2026-11-12 02:11
- Branch: `fix/firewall-live-check`
- Status: done (PR open)
- Where: trina-ax core (`native/internal/fwprobe`, `native/cmd/mycel-launcher`, `native/cmd/mycel-ctl`,
  `scripts/linux/systemd/firewall.timer.in`; `shared/src/engine.ts`, `shared/src/api/errors.ts`;
  `server/src/chat/turn.ts`, `server/src/system/ops.ts`, `server/src/system/messages*.ts`; tests). Why: the Linux
  run base is core (docs/REPOSITORY-RULES.md).
- Version impact: patch (a security fix inside the Linux launcher and its diagnostics; no API shape, data or migration
  change, the timer template changes but renders with every released `mycel-ctl`).

## Goal (QA TC-310, Ubuntu 24.04)

After `nft flush ruleset` as root (another tool such as a Docker or ufw reload can do the same), the engine account
reached the LAN, the cloud metadata address and the internet until the status file `run/firewall.json` was 10 minutes
old. Then the person read "The answer stopped partway" (`internal/crash`). Meanwhile `mycel-ctl status` said
`firewallOk: true` and Admin › Diagnostics folded the firewall away as passed. Cause: the launcher, `mycel-ctl status`
and the server only read the status file; nothing looked at what the kernel holds.

## How

- **Live check in the launcher, before every turn.** The launcher runs as the engine account with no capabilities, so
  it cannot list nftables. It tests what the rules do instead, as the engine account: a TCP connection to its own
  listener on 127.0.0.1 (another port than the model proxy), to the cloud metadata address and to a documentation
  (never routed) public address must each be refused at once (the table's `reject with tcp reset`). A connection that
  goes through, or any other answer, means the table is gone or changed: the turn is refused with
  `firewall_off: …`. A good answer is kept for 3 seconds; a bad one is never kept.
- **The status file check stays** (fresh, loaded, same uid and port) and runs first.
- **Faster repair.** The firewall timer re-applies every 30 seconds instead of 2 minutes (`supervise` too), so a
  flushed table is back within half a minute and the next try works. The launcher cannot re-apply itself (no root,
  by design: the root unit takes no input from the launcher).
- **Plain words for the person.** The server maps the launcher's `firewall_off` / `firewall_not_loaded` to a new chat
  error `network_protection_off` (English first, five languages): "The server's network protection is off, so the AI
  can't run right now. Try again in a minute; if it keeps happening, ask your admin to check Trina's server." Never
  retried as a crash.
- **`mycel-ctl status` reports the live table.** As root it lists `table inet <id>` and runs the same structure check
  as `firewall apply` (`checkTable`). A missing or changed table makes `firewallOk: false` with the reason, and
  `firewallLive` says what the kernel holds.
- **Admin › Diagnostics.** The launcher's status report carries the live result (`firewall.live`,
  `firewall.liveProblem`); the firewall line turns into a failure with plain words ("The engine's network protection is
  not in effect on the server right now …") when it is false, so it is listed first instead of folded under passed.

## Scope

In: the above, a Go test for the probe, a `mycel-ctl status` test with a fake `nft`, server unit tests (diagnostics
line, chat error), and a Docker attack-suite case: flush the ruleset, the next turn is refused with `firewall_off`;
after re-apply turns run again.
Out: killing a turn that is already running when the table disappears (the next turn is refused; the 30 s timer
repairs); a root watcher on nftables events (`nft monitor`) that re-applies at once (a new unit for existing installs).

## Risks

- A false refusal under heavy load: the refused connects are local (no network round trip); the timeout is 1 s each.
- The probe listens on a random loopback port as the engine account for a moment; it never takes the proxy port.
- No migration. Five languages for the two new strings.

## Tests

`go test ./native/...` (touched packages), `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, unit tests
for the diagnostics and chat errors, the Docker Linux attack suite (`tests/linux`).

## Result

Built as planned. The two remote probes run at the same time (the worst case waits one timeout, not two). The Docker
attack suite flushes the ruleset with a fresh status file: the next turn is refused with `firewall_off`, the launcher
reports `firewall.live: false`, and after `firewall apply` turns run and `live` is true again.
