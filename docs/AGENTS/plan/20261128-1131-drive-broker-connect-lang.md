# The hosting service's Google connect page speaks the person's language

- Date (UTC): 2026-11-28 11:31
- Branch: `fix/drive-broker-connect-lang`
- Status: done
- Where: `shared/src/cloud-protocol/drive-broker.ts` (MIT wire contract), `server/src/integrations/google-drive/`,
  `server/src/integrations/google-apps/`. Why: the team server is the only side that knows the person's Trina language.
- Version impact: patch: a fix; one new optional request field that older control planes are retried without.

## Goal

Windows QA 2026-11-28: a Korean team on a self-registered 0.20.2 server opened
`account.trina.app/drive-broker/connect` and saw English ("Connect Google Drive", "Continue to Google"). The control
plane picks the page language from `?lang=`, then the team's `default_locale` (hosted teams only; a registered server
has none), then the browser's Accept-Language, then English. Nothing tells it the person's Trina language, so a
self-installed server's people get whatever the browser sends. After this, the start page, Google's own screen and the
pages after it follow the person's Trina language, in all six languages.

## Scope

In:
- Protocol: `DriveBrokerStart` gets an optional `locale` (one of `DRIVE_BROKER_LOCALES`: en ko ja zh es id).
  `parseDriveBrokerStart` accepts it (and only those values). The control plane stores it with the sign-in and uses it
  for its pages (trina-cloud, its own PR).
- Team server: Drive and the Google apps send the person's `users.locale` with `start`. An older control plane refuses
  the unknown key (`invalid_request`): start again once without `locale`, so nothing breaks before it is deployed.

Out: Sign in with Google (its own broker, no page of ours before Google).

## Steps

1. Protocol field + parser + header comment.
2. `DriveBroker.start(…, { locale })`: send it, retry without it on `invalid_request`.
3. Callers pass `personLocale` of the person signing in.
4. Tests: parser (accepts six, refuses others), start sends the locale, old-broker retry, Drive and an app.

## Decisions

none (an optional field with a retry, like `purpose: share` for apps).

## Risks

No migration. A newer control plane must accept the field before every server sends it; the retry covers the gap
(one extra signed call per sign-in until the CP deploy). The MIT file stays import-free.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/c-drive-broker.test.ts`,
`tests/unit/c-google-apps-team-broker.test.ts`, `tests/unit/c-google-apps-signin.test.ts`.

## Result

Built as planned. \`DriveBroker.start\` sends \`locale\` = the person's \`users.locale\` (their own choice or the team
default they follow); on \`invalid_request\` it asks once more without it. A Google app team sign-in on a control plane
from before both fields asks \`share\`+locale, \`share\`, then \`personal\`+locale. The control plane side (store it with
the state, use it on the start page and Google's return, \`hl\` for Google) is trina-cloud's PR. Tests: 4 broker files,
53 pass; \`check:prepush\` ok.

