# Opt-in error reports to Sentry for the team server and the web app

- Date (UTC): 2026-11-07 08:09
- Branch: `feat/sentry-error-reporting`
- Status: in progress
- Where: this repo, `server/src/system/`, `server/src/log.ts` and `web/src/lib/`. Why: a common, off-by-default hook
  that any install can use; nothing here is specific to one customer.
- Version impact: minor (new optional `MYCEL_*` settings and a new optional HTTP endpoint; nothing changes without them)

## Goal

Maintainers learn about server and browser errors on the development server without waiting for a bug report. Nothing
changes for customers: with no key set, no report is built and nothing leaves the server.

## Scope

In:

- A small sender in this repo (no Sentry SDK, no new dependency) that posts only allowed fields to a Sentry address.
- Reports for error-level log lines, unhandled 500s, crashes and browser errors.
- Settings: `MYCEL_SENTRY_DSN` (server), `MYCEL_SENTRY_WEB_DSN` (browser reports), `MYCEL_SENTRY_ENV` (the environment
  name). An admin of a self-hosted server may set their own key; no key ships in this repo.
- Browser errors go to a signed-in endpoint on the team server, which scrubs them and forwards them. The Content
  Security Policy does not change, and the browser never holds a key.

Out:

- Hosted team servers. The sender refuses to start there even with a key set: sending from them needs a terms and
  privacy change first.
- Desktop, mobile, relay and push gateway. The mobile app's privacy text says it has no analytics or tracking tools.
- Web source maps. Web stack traces stay minified for now; adding maps needs a change around `dev-build.yml`, so it is a
  follow-up with the release owner.
- Tracing, Sentry logs and session replay.

## Steps

1. Write this plan (first commit).
2. `server/src/system/error-report.ts`: read the settings, parse the key, build the allowed fields, scrub, send with
   limits. Sending must never throw, and never log at error level (that would report itself).
3. `server/src/log.ts`: an optional hook on error-level lines. `server/src/app.ts`: pass the route pattern, not the path.
4. `server/src/main.ts`: when reports are on, send crashes, wait briefly, then exit as before.
5. `POST /api/client-errors`: signed in, small body, rate limited, not found when off. `GET /api/me` tells the web app
   whether to report.
6. `web/src/lib/error-report.ts`: window error listeners, only when the server says reports are on.
7. Docs: `docs/CONFIGURATION.md`, `docs/DECISIONS.md`, `CHANGELOG.md`.

## What a report may hold

Allowed: error type, scrubbed message, stack frames (file name, function, line), release, environment, HTTP method,
route pattern (`/api/files/:id`), the first segment of the web page path.

Never: chat text, prompts, file names, paths or contents, request bodies, emails, names, tokens, engine stderr, log
fields other than those above, hostnames, IP addresses. Sentry adds the country of the server that posted the report.

The allowlist is the sender itself: a field reaches Sentry only if the code names it.

## Risks

- Security: a scrubber can miss something. Messages are cut short; quoted text, paths, addresses, long ids and non-ASCII
  text are replaced. A canary test feeds real-looking secrets through every entry point.
- A crash handler changes process behaviour, so it is installed only when reports are on, and it still exits with code 1.
- An error storm: the sender drops repeats, caps reports per minute and obeys Sentry's rate limit answers.
- A new endpoint: it needs a session, takes a small body, and is off unless a key is set.
- Web reports also come from the desktop and phone apps, which load the same page. Only the development server sets a
  key today; hosted servers refuse.
- No migration. No new app strings, so the five languages are not affected.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, and unit tests for the sender (allowlist, canary,
limits, off by default, hosted refusal), the log hook, the endpoint and the web reporter. One real test event from the
development server after merge.

## Result

Filled in at the end.
