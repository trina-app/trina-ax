# Free-roam demo gate on a Linux host (up to 30 visitors)

- Date (UTC): 2026-11-23 08:37
- Branch: `feat/demo-gate-linux`
- Status: done
- Where: demo-gate/ (example config, README, `linux/` hosting files), server/src/proxy (model proxy inner port),
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

PR: https://github.com/trina-app/trina-ax/pull/446
