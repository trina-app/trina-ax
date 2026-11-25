# Check again toasts say what this check learned, in plain words

- Date (UTC): 2026-11-25 02:30
- Branch: `fix/credential-check-again-toasts`
- Status: in progress
- Where: server/src/credentials, shared/src/api, web (admin AI providers, connectors). Why: QA TC-9060, TC-9061 on
  #559's "Check again" toasts (see docs/REPOSITORY-RULES.md)
- Version impact: patch: fixes wrong and untranslated toast text of an existing button; no new feature

## Goal

1. TC-9060: Check again on an account that is already Refused, when the provider cannot be reached (network error,
   timeout), says "여전히 거절됨: <old reason>". This check learned nothing, so it must say "확인 못 함: 잠시 후 다시 해
   주세요" and never re-assert the old state.
2. TC-9061: the Korean toast shows the provider's raw English text and the code `authentication_error`. The toast must
   give a plain reason in the person's language; the raw answer stays in the opened row only. "받아 줬어요" →
   "받아줬어요".
3. Check again on an app on this computer (or any connector) toasts "See the list for the reason" on a page that shows
   the reason already. The toast states the outcome and nothing more.

## Scope

In:
- `checkCredential` (service.ts): the outcome comes from this check's own answer. `refused` only when the check was
  refused (401, an API key's 403, an account-level 403, a ChatGPT refresh refused for good) or when it passed but the
  account stays refused for a reason a check cannot clear (a ChatGPT plan without Codex). Anything else (no answer,
  timeout, 5xx, 429, an unclear 403, a kind that is off on this server) is `unclear`, whatever the stored state.
- `check.why` (shared CheckCredentialResponse): a known reason (`authentication`, `permission`, `org_oauth_blocked`,
  `plan_ended`, `rate_limited`, `usage_limit`, `overloaded`, `unreachable`) mapped from the provider's error type,
  the mark code and the HTTP status. `reason` stays the provider's cleaned text (for the API and the row details).
- Web (Credentials.tsx): toast text from `credentials.why.*` keys in en/ko/es/ja/id/zh; refused with no known reason
  uses the row's own localized line; never the raw `reason`. Unclear: the known reason as the second line, else none.
- ko spacing: "받아줬어요" (toast) and "받아줘서" (server notice).
- Connectors' Check again / save toasts: drop "See the list for the reason" in six languages.

Out: the background re-check and the confirm-before-mark flow (unchanged); the row details layout.

## Steps

1. Plan (this file).
2. Server outcome + `why`, shared schema, http-api docs regenerate if the schema text changes.
3. Web toasts and i18n (six languages), connectors toast text.
4. Tests: server outcome on a network failure / timeout for a refused row (a-credentials-recheck), `why` mapping;
   web toast text in ko and en (credential-check-again).
5. `bun run typecheck`, `bun run check:prepush`, the three named test files.

## Decisions

None new; follows docs/decisions/20261125-ai-account-refusal-recheck.md.

## Risks

No migration. Six locales (check:i18n). The API field `check.why` is optional and additive.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/a-credentials-api.test.ts, tests/unit/a-credentials-recheck.test.ts,
web/test/unit/credential-check-again.test.tsx.

## Result

(filled in at the end)
