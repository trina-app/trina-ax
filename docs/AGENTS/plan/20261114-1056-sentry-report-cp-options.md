# Sentry reporter: level, fingerprint, message events, kept Korean titles, route tags and check-ins

- Date (UTC): 2026-11-14 10:56
- Branch: `feat/sentry-report-cp-options`
- Status: done
- Where: Team AX core (`shared/src/sentry-report.ts`). Why: the Trina Cloud control plane copies this file at a pinned
  commit for its own Sentry reports (PR 0 of the CP Sentry plan), so the options it needs belong in the one allowlist.
- Version impact: none (no team server or app change; the relay and the push gateway behave as before)

## Goal

The control plane needs a few more shapes of report than the relay and the push gateway: warnings, its own grouping,
message events for alerts with code-written Korean titles, the Hono route pattern as a tag, and cron check-ins from
code. Each is a privacy decision, so each stays narrow and is checked here.

## Scope

In:
- `ErrorInput.level` (`error` | `warning`; `fatal` still wins), `fingerprint` (at most 4 parts, every part a
  code or a route pattern, otherwise no fingerprint), `kind: 'message'` (`message.formatted` instead of
  `exception`), `keepText` (keeps Hangul only; every other scrub rule still runs).
- A route-pattern rule (`ROUTE_VALUE_RE`) for the `route` tag and fingerprint parts; `TAG_VALUE_RE` unchanged.
- `checkIn(dsn, slug, body, {fetch, timeoutMs})`: never throws, a body allowlist, honours rate limits for the
  `monitor` category; an error-only limit does not pause check-ins, a monitor-only limit does not pause errors.
- Tests in `tests/unit/sentry-report.test.ts`, including leak tests; a DECISIONS entry.

Out: the control plane side (copy, credential, captures, monitors), which is in the trina-cloud repository.

## Steps

1. Options and rules in `shared/src/sentry-report.ts`.
2. Tests: event shapes, leak canaries for every new path, rate-limit categories, check-in body allowlist.
3. DECISIONS entry. No changelog fragment (no user-visible change).

## Risks

- A route rule that lets a real path through. Literal parts are short lowercase words without dots, `@` or digit runs;
  a word-like slug still cannot be told from a route word, so callers pass the route pattern only (documented).
- `keepText` on a message that holds a person's name. Callers may pass it only for titles written in code (documented).

## Result

Options, `ROUTE_VALUE_RE`, `cleanFingerprint`, `cleanCheckInBody` and `checkIn` in `shared/src/sentry-report.ts`;
tests in `tests/unit/sentry-report.test.ts`; DECISIONS entry "Sentry reporter options for the control plane". No
changelog fragment: nothing changes for users.
