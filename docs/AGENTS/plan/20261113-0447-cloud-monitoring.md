# Error reports and cron check-ins for the relay and the push gateway

- Date (UTC): 2026-11-13 04:47
- Branch: `feat/cloud-monitoring`
- Status: done
- Where: this repo, `relay/`, `push-gateway/`, `shared/src/sentry-report.ts`. Why: both services and their deploy files
  live here; nothing of a customer server or the private core is touched (see docs/REPOSITORY-RULES.md)
- Version impact: none for the Trina AX release: the team server, the web app and the phone and desktop apps do not
  change. The relay gets new optional settings (a minor change for the relay bundle, `RELAY_VERSION` 0.2.0); its version
  is bumped by whoever cuts the next relay bundle, not in this PR.

## Goal

The operators of the hosted services (the relay and the push gateway) learn about a failure from Sentry instead of from
a customer: a crash, an error line in the relay log, Apple or Google refusing our push credentials, a nightly backup
that did not run, Litestream that stopped copying the registry. Nothing is sent unless the operator sets a Sentry key on
the host; a host without one sends nothing at all. Every report comes from a real failure path: no test route, no test
event.

## Scope

In:

1. `shared/src/sentry-report.ts`: the approach of PR #168 (`server/src/system/error-report.ts`, "Error reports to
   Sentry" in docs/DECISIONS.md) for a server process: no Sentry SDK, `buildEvent` is the allowlist, the same scrubber
   rules, the same limits (one copy of a repeated error a minute, at most 30 a minute, a crash always goes, Sentry's
   429 and rate-limit headers pause sending). It adds `checkInUrl` (the cron endpoint from a DSN) and validated tags.
   Written in erasable TypeScript, because the relay runs its `.ts` files under Node with type stripping.
2. Relay: `RELAY_SENTRY_DSN` and `RELAY_SENTRY_ENV` (default `production`) in `relay.env`, empty by default. Captured:
   `uncaughtException`, `unhandledRejection` (then exit 1 as now, so systemd restarts the same way), and every
   `log.error` line through a hook in `relay/src/log.ts`, after the forbidden fields are dropped. The event holds the
   log event name and the scrubbed `error` field only. Tags: `release` = `relay@<RELAY_VERSION>`, `environment`,
   `instance` (`a`/`b`, from `Environment=RELAY_INSTANCE=%i` in the unit).
3. Push gateway: `PUSH_GATEWAY_SENTRY_DSN` and `PUSH_GATEWAY_SENTRY_ENV`. Captured: crashes; a send that threw
   (`internal`); and our own credentials refused: APNs 403 `InvalidProviderToken`, `ExpiredProviderToken` after a
   fresh token, `MissingProviderToken`, `BadCertificate*`, `TopicDisallowed`, `BadTopic`, an unreadable `.p8`; FCM
   OAuth token call refused, send 401/403 (`UNAUTHENTICATED`, `PERMISSION_DENIED`, `THIRD_PARTY_AUTH_ERROR`), an
   unreadable service-account key or JSON. Tags `provider` and `reason` (a fixed list). A dead device token
   (`Unregistered`, `BadDeviceToken`, 410, `UNREGISTERED`) stays a log line only. Never a device token, payload,
   key, team key id or client address. Release = `push-gateway@<first 12 hex of the running file's sha256>`.
4. Cron check-ins from the real jobs through one wrapper, `relay/deploy/relay-checkin.sh <slug> <schedule> -- <job>`:
   `in_progress` (with `monitor_config`, so the monitor is created on the first run), then `ok` or `error` with the
   job's exit code kept. `curl` with a 10 s limit; a failed check-in never fails the job; no DSN = runs the job only.
   - `registry-backup.service` → `relay-registry-backup` (daily 18:40 UTC)
   - `cf-ips-refresh.service` → `relay-cf-ips-refresh` (Mondays 03:17 UTC, 30 min random delay)
   - new `litestream-check.{sh,service,timer}` every 15 min → `relay-litestream`: error when the `litestream` unit is
     not active, `litestream ltx` cannot read the replica, or the registry changed more than 15 min after the newest
     replica file.
   - Installed by `setup-host.sh` like the existing timers (wrapper and check in `/usr/local/sbin`, so they do not
     depend on which release `current` points at). `relay-deploy.sh` does not install timers today and stays as is.
5. Docs: an operator section in `relay/deploy/README.md` and `push-gateway/README.md` (the setting, what is sent, what
   is never sent, monitor slugs). DECISIONS.md: a short entry that points at PR #168's entry and states only what
   differs (no hosted refusal: these are our own services and Sentry already receives nothing customer-owned from
   them; the credential-rejection rule; check-ins).
6. Tests (fictional DSNs only, fake `fetch`, a fake `curl` on `PATH`).

Out:

- The team server update timer (`mycel-ctl update --scheduled`): its opt-in setting would be PR #168's
  `MYCEL_SENTRY_DSN`, with that PR's hosted refusal, and PR #168 is not merged. Doing it here would invent a second
  setting or copy the refusal. Follow-up after PR #168 merges.
- Sharing one scrubber: PR #168 keeps its own copy in `server/src/system/error-report.ts`. Follow-up: once it merges,
  make the server import `shared/src/sentry-report.ts` (the browser parts stay in the server) so there is one list.
- No deploy. The hosts get the settings only with the owner's OK.

## Steps

1. Plan (this commit).
2. `shared/src/sentry-report.ts` + bundle it with the relay (`scripts/build-relay.ts`, the self-reference export).
3. Relay hook and crash handlers; env example; unit `RELAY_INSTANCE`.
4. Push gateway: an `alarm` dependency called by APNs/FCM on credential rejection; wiring in `bun.ts`.
5. Check-in wrapper, Litestream check, units, `setup-host.sh`.
6. Docs, changelog fragment, tests, checks, PR.

## Risks

- Privacy: the relay log never had IPs, paths or headers (`FORBIDDEN_LOG_FIELDS`); the report reads only the event
  name and the `error` field, scrubbed again. Tests check a canary IP, path, token and header value never reach a body.
- A report storm: the per-minute limits; credential rejection repeats on every send, so the "one copy a minute" rule
  holds it to one event a minute per reason.
- The relay must still start without the shared file in the bundle: the bundle test runs it under Node.
- `litestream ltx -json` is Litestream 0.5's command (the host pins 0.5.17); if the output cannot be read the check
  reports `error`, so a format change is seen, not hidden.
- No migration, no UI, no app languages touched.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/f-relay* tests/unit/f-build-relay*
tests/unit/push-gateway* tests/unit/sentry-report* tests/unit/relay-checkin*`, `bash -n` and shellcheck on the scripts.

## Result

Built as planned. Differences: the relay also reports a start that failed (a port taken, a certificate missing), the
push gateway also reports a service-account JSON that is set but cannot be read, and FCM `SENDER_ID_MISMATCH` (it comes
with `PERMISSION_DENIED`) counts as a device-token problem, not ours. The reason of a credential refusal is a tag only:
the scrubber would cut a long code like `InvalidProviderToken` out of the message. The Litestream check reads file times
with `date -r` (GNU and BSD) so its test runs on a Mac too. Team server update timer left out (see Out). Not deployed.
PR: see the pull request that links this plan.
