# Engine turns get their own network namespace (host abstract unix sockets out of reach)

- Date (UTC): 2026-11-12 03:35
- Branch: `fix/engine-abstract-sockets`
- Status: in progress
- Where: `native/` (mycel-sandbox, mycel-launcher, internal/seccomp) and `tests/linux`. Why: the Linux engine sandbox is Team AX core (docs/REPOSITORY-RULES.md).
- Version impact: patch, a security fix in the existing sandbox without a new setting

## Goal

QA TC-309: on Linux kernels before 6.12 (Ubuntu 22.04/24.04, Debian 12) a turn shares the host network namespace, and
Landlock's abstract-socket scope needs ABI 6. Host services listening on abstract unix sockets (`@...`, e.g.
multipathd, iscsid, systemd/dbus helpers) accept connections from the engine. A taken-over engine must reach only the
model proxy.

## Scope

In:
- Every bwrap turn runs in a new network namespace (abstract unix sockets belong to a network namespace). Only
  loopback exists inside.
- A small forwarder (`mycel-sandbox forward`) stays in the host namespace, inside the turn (same session, engine
  account, turn cgroup). It accepts on 127.0.0.1:<proxy port> inside the turn's namespace and connects to the real
  model proxy, so the engines' configuration, the nftables rule and the proxy's tcp-peer check stay as they are.
- The forwarder: no capabilities, not dumpable, seccomp with no unix sockets and no exec.
- Why not seccomp alone: it cannot read the address behind connect()'s pointer, and the bridge needs a unix socket
  (tools.sock is a path, which still works across network namespaces).
- Linux attack suite: a host abstract listener the turn must not reach; Go tests for the bwrap argv, the seccomp
  variant and the helper's flags.

Out: macOS (Seatbelt has no abstract sockets); the server's converters (their bwrap already uses its own network
namespace).

## Steps

1. seccomp: an option that also refuses AF_UNIX sockets and execve (forwarder only).
2. mycel-sandbox exec `--net-proxy PORT`: start the forwarder, unshare the network namespace, bring lo up, listen on
   127.0.0.1:PORT, hand the listener over, drop every capability, then Landlock + seccomp + execve as before.
3. Launcher: bwrap gets `--cap-add CAP_SYS_ADMIN --cap-add CAP_NET_ADMIN` (inside the turn's user namespace only,
   dropped by the helper before the engine runs) and the helper gets `--net-proxy`.
4. Tests (Go, Docker attack suite), DECISIONS.md entry, changes fragment.

## Risks

- The helper briefly holds namespace capabilities: it drops them before Landlock/seccomp and checks /proc/self/status
  (fail closed, exit 70).
- Engines that do not use the proxy's 127.0.0.1 address lose network: none do (ANTHROPIC_BASE_URL, HTTPS_PROXY,
  Codex's provider URL are all 127.0.0.1:<port>).
- No migration, no UI, no languages.

## Result

(filled in at the end)
