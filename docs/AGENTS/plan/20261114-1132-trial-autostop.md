# Hosted teams that sleep: idle facts on the team server, sleep flag and wake on the relay

- Date (UTC): 2026-11-14 11:32
- Branch: `feat/trial-autostop`
- Status: in progress
- Where: trina-ax (team server, mycel-ctl, relay, shared cloud protocol). Why: the hosting control plane already stops
  idle hosted servers and starts them again, but the team server cannot tell it whether it is idle, and the relay
  does not know a stopped team or ask for it to start (see docs/REPOSITORY-RULES.md: relay and team server are core).
- Version impact: minor, a new tenant command flag, a relay operator route and a relay page.

## Goal

The hosting service stops an idle trial team's server to save cost and starts it again when someone opens the team.
Someone who opens a stopped team sees "Starting your team…" (about a minute) and the page opens by itself when the
server is back. Apps and webhooks get a retryable 503.

## Scope

In: port the unmerged F2 sleep work onto dev:
- shared cloud protocol: idle-wait `--activity` facts, relay sleep flag, relay wake request (same as the control
  plane's vendored copy);
- team server: when it was last in use (signed-in request, open app connection, running answer, background job,
  backup, running dev environment command), the next due schedule or push retry, `admin.js cloud-idle`;
- mycel-ctl `idle-wait --activity`;
- relay: per-team sleep flag (operator route), wake request to the control plane, the waking page.
Out: the relay client time-jump reconnect of the original branch (a hosted server that sleeps is stopped and
started, a fresh boot). Control plane changes live in the hosting repo.

## Steps

1. Contract (shared/src/cloud-protocol, shared/src/install.ts).
2. Team server activity facts and cloud-idle; mycel-ctl --activity.
3. Relay flag, wake client, page.
4. Tests, relay README, DECISIONS, changes fragment.

## Risks

A new relay registry migration (appended). Wrong idle facts would stop a team in use: every unknown or failed read
counts as "in use". The waking page is in the five app languages.

## Tests

`bun run typecheck`, relay tests, the F2 unit tests, mycel-ctl Go tests.

## Result
