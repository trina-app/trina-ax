# Relay wake answer: a "no room" hint and a calm waiting page

- Date (UTC): 2026-11-22 05:54
- Branch: `feat/wake-busy-no-room`
- Status: in progress
- Where: `shared/src/cloud-protocol/` (relay wake contract), `relay/`. Why: the relay draws the page a visitor of a
  sleeping hosted team sees, and the wake answer is the relay ↔ control plane contract (docs/REPOSITORY-RULES.md)
- Version impact: minor. A new optional contract field and a new visitor page; old relays and old control planes keep
  working unchanged.

## Goal

trina-cloud #157 retries the wake of a sleeping paid team whose wake was refused for lack of server room (every 5 min
for 2 h, then every 30 min) and emails the owners when it is up. Today the visitor sees "The team server is busy.
Please try again shortly." and would keep reloading. With the hint the page says calmly that we wake the team as soon
as there is room and email the owners, and it reloads at most once a minute.

## Scope

In:
- `OpsWakeResponse.reason?: 'no_room'` (only with `state: 'busy'`), the zod mirror, the contract README.
- The relay's wake client keeps the hint (it ignores any other value, and the hint on another state).
- A new page kind `team_no_room` in 6 languages: 503, `x-relay-error: team_busy` (unchanged, so every app that reads
  the header keeps working) plus `x-relay-detail: no_room`; JSON `reason: team_busy`, `detail: no_room`. The page
  reloads itself after the control plane's `retryAfterSec`, kept to 60-300 s; Retry-After the same.

Out: the control plane sending the hint (trina-cloud follow-up). Any change to the apps.

## Steps

1. Contract: type, zod schema, README line.
2. `relay/src/wake.ts` keeps `reason: 'no_room'`; `relay/src/relay.ts` picks `team_no_room` for it.
3. `relay/src/pages.ts`: texts, status, Retry-After, meta refresh 60-300 s.
4. Tests: `tests/unit/f2-relay-wake.test.ts` (client and page), `tests/relay/f-sleep.test.ts` (end to end),
   `tests/unit/i18n-languages.test.ts` (no Korean in the other languages); `relay/README.md`.

## Decisions

none (an additive optional field, as `shared/src/cloud-protocol/README.md` "Rules" allows).

## Risks

A contract change: the control plane copies the folder at a pinned commit, so it syncs after this merges before it
sends the field. Old relays ignore it (the wake client builds a new object from `state` and `retryAfterSec`).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:prepush`, the relay and cloud-protocol unit tests.

## Result

