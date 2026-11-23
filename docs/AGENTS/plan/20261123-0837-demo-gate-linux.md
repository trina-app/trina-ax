# Free-roam demo gate on a Linux host (up to 30 visitors)

- Date (UTC): 2026-11-23 08:37
- Branch: `feat/demo-gate-linux`
- Status: done
- Where: demo-gate/ (example config, README, `linux/` hosting files), server/src/proxy (model proxy inner port),
  server/src/files/html-pdf.ts (browser owner check inside the instance bwrap, behind an env flag),
  server/src/app-config.ts. Why: the gate and its hosting files live with the gate; the inner port is the server's own
  listener (see docs/REPOSITORY-RULES.md)
- Version impact: none. demo-gate is a private operator tool; the server's new `engine.proxyInnerPort` is optional and
  changes nothing when it is absent (every released install leaves it out)

## Goal

The free-roam demo (demo.trina.app) runs on one Mac with room for 10 visitors. Move it to a Linux host with room for 30,
with the same isolation: the gate holds the only AI credential, the instances run as their own user with no network
but their loopback ports, and the tunnel reaches only Cloudflare.

## Scope

In:
- `demo-gate/gate.example.linux.json`: instances on an XFS file system with reflink (`cp --reflink=always -R`), each
  instance under `choom -n 800` (the kernel ends an instance before the gate), `maxLive` 30, `limits.maxStreams` 12,
  `pool.path` with the instance user's Claude Code.
- The model proxy's internal Bun.serve gets a fixed port (`engine.proxyInnerPort`, server; the gate gives each instance a
  third port of `pool.portRange`), so the Linux firewall can allow the instance user only the instance range instead of
  every ephemeral loopback port (the open follow-up of the Mac pf rules).
- `demo-gate/linux/`: the nft table (`inet trina_demo`, by socket uid, beside Docker's and Tailscale's tables), systemd
  units (gate with MemoryHigh 16G / MemoryMax 18G, tunnel, nft refresh, nightly snapshots, credential copy), the
  snapshot rebuild as a POSIX sh script, the credential helpers, the sudoers file, pinned downloads (`pins.env`),
  `stage.sh` (no root: downloads and app build) and `install.sh` (root, idempotent).
- README section "Hosting on Linux", with the tunnel warning (never a second connector on the live tunnel).

Out: the host itself (done by the operator with install.sh), the cut-over of demo.trina.app, the Claude login of the
credential user (a person signs in).

## Steps

1. Plan (this file).
2. Server: `engine.proxyInnerPort` → ModelProxyService → `startModelProxy({ innerPort })`; tests.
3. demo-gate: three ports per instance, `engine.proxyInnerPort` in the instance's server.json; portRange of at least
   three ports; gate test.
4. `gate.example.linux.json`, `demo-gate/linux/*`, README.
5. typecheck, check:prepush, `bun run test:demo-gate`, the proxy tests.

## Decisions

none (hosting files of an operator tool; the firewall follows the Mac pf rules one to one, minus the ephemeral-port
line this removes)

## Risks

- A server.json with `engine.proxyInnerPort` read by an older server: the key is ignored (the engine object is not
  strict), the inner port is the OS's choice as before.
- A taken inner port: the proxy does not start (like a taken proxy port); the gate picks only free ports.
- Linux dev-mode engines have no OS sandbox of their own (server/src/context.ts `devEngineSandbox`, macOS only): the
  instances rely on Claude Code's tool lockdown, the nft table, the unit's ProtectHome/ProtectSystem and one user for
  all instances. Noted in the README.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run test:demo-gate`, `bun test tests/unit/proxy-inner-port.test.ts
tests/unit/proxy.test.ts tests/unit/proxy-subscription.test.ts`.

## Result

Built as planned, plus `tdfw-check` (the per-user firewall checks; install.sh runs it last and stops on a failure).
Node 26 and bun are pinned in `demo-gate/linux/pins.env`, not in `scripts/system/packages.json`: that list is shipped
to every Linux install and a change there is a root update; chrome-headless-shell comes from the list.

Checked on an Ubuntu 26.04 host as an unprivileged user (no root yet): `stage.sh` (downloads, sha256, app build), a
snapshot build plus canary, the HTML-to-PDF prints under bwrap, the nft table loading in a private network namespace,
and a same-user gate (allowSameUser) with that snapshot: two warm instances in about 1.1 s each, a start signs the
visitor in as Mina, PAUSE closes and reopens, and a chat turn goes engine → instance model proxy (inner port fixed in
the range) → gate upstream → Anthropic (401 with a placeholder credential, answered "The demo is busy").

Security review fixes (same PR): `/srv/tdg` root's with the instances in `/srv/tdg/i`; `tdsnap-rebuild` never acts as
root in a folder another user can write (the snapshot leaves as a checked tar stream, tdgate unpacks it); the snapshot
unit has its own network namespace (no nft chain for the builder); `nofail,discard` in fstab, fallocate after a
free-space check; `tdfw-check` before any unit starts and again after (stops the gate and tunnel on a failure);
install.sh reads only a root-owned copy of the stage and unpacks the checked downloads itself; each instance in its
own bwrap (`pool.command`); the gate unit hardened (ProtectSystem=strict, InaccessiblePaths for the
host's other services and CI runners, IPAddressDeny/Allow backstop, MemoryMax 14G, lower CPU and IO weight); the nft
refresh every minute. Inside the instance bwrap root is not mapped, so the HTML-to-PDF browser check would refuse the
root-owned browser: `MYCEL_SANDBOX_ROOT_UNMAPPED=1` makes `rootOwnerUids` (server/src/files/html-pdf.ts) count the
overflow uid as root when "/" itself shows as that uid. Checked on the host as an unprivileged user: the same-user gate
with the bwrap command (warm, start, a chat turn to Anthropic answered "busy", the instances ended with the gate) and
the HTML-to-PDF prints nested inside the instance bwrap.

Re-review: the gate unit keeps NoNewPrivileges off (sudo): no PrivateDevices, ProtectKernelModules, ProtectClock,
LockPersonality, RestrictRealtime, RestrictSUIDSGID or SystemCallArchitectures, which turn it on for a unit that is not
root; install.sh checks sudo plus the instance sandbox in a transient unit with the gate unit's properties before the
start, and that the gate warms an instance after (else it stops the units). The overflow uid counts as root only for
the explicit MYCEL_HTML_PDF_BROWSER inside the folder MYCEL_SANDBOX_ROOT_UNMAPPED names (/opt/trina-demo). Secrets
must be plain files. Ubuntu 26.04's sudo is sudo-rs: the sudoers file sets only `Defaults:tdgate !use_pty` (sudo-rs
refuses requiretty and log_output; it never asks for a tty and has no I/O logging); install.sh stops if a sudo.ws host
logs I/O. The first install run also found that install.sh read its hosting files from the stage copy after moving
the app out of it (fixed), that systemd-run takes no `localhost` in IPAddressAllow (spelled out), and that
ProtectHostname breaks the instance bwrap's /proc (it mounts /proc/sys/kernel/hostname read-only; removed).

The real install also found: the canary needs its list 600 (now tdbuild's), example.com is on Cloudflare (tdfw-check
probes off it), and the credential timer stays off on a host with a long-lived token.

Review of the live host: any code running as the instance user could sign in to another instance through
`POST /api/demo/persona`. The gate now makes a key per instance, keeps it in memory and writes only its SHA-256 to the
clone's demo file (`gateKeySha256`); the server compares in constant time, and the gate refuses an instance that signs
in without the key. Each instance also gets its own UTS namespace and `tdscope`, a Landlock domain scoping abstract
unix sockets (without it an instance could connect to the desktop's X11 socket).

Second review: the key check fails closed (a free-roam instance without a hash signs nobody in; only the guided demo and
the builder's own server have no key; the snapshot check uses a throwaway key). install.sh migrates an older
`pool.command` with a backup, refuses one without the whole sandbox, and stops the units before it changes the app.

PR: https://github.com/trina-app/trina-ax/pull/446
