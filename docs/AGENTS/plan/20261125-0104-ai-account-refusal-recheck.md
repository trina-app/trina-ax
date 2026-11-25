# A refused AI account is confirmed before it is marked, re-checked by itself, and "Check again" says what it found

- Date (UTC): 2026-11-25 01:04
- Branch: `fix/ai-account-refusal-recheck`
- Status: done
- Where: server/src/credentials (broker, store, validate, service, maintenance, i18n), server/src/proxy (model-proxy,
  anthropic-refusal, codex-path), shared/src/api/credentials.ts, web/src/pages/admin/Credentials.tsx, web/src/i18n
  (6 languages). Why: AI connections are area A (docs/WORKPLAN.md).
- Version impact: patch: fixes accounts wrongly shown as refused and a re-check that showed no result; no new setting,
  no migration, the API only gains optional fields.

## Goal

On potenlab.trina.app Claude subscription accounts show "거절됨". Two were really revoked (401). Two got 403 "OAuth
authentication is currently not allowed for this organization.", an answer that can pass: team.trina came back on a
manual re-check five days later with the same token. Our bugs:

- (a) one 401 during use marks the account refused for good, with no confirming check
  (model-proxy.ts 401 → broker.onUnauthorized → store.markInvalid);
- (b) the org-not-allowed 403 is stored as `plan_ended` (anthropic-refusal.ts);
- (c) nothing re-checks refused accounts by itself;
- (d) the provider's error message is not kept;
- (e) "다시 확인" shows nothing: the ⋯ menu closes so "확인 중…" is never seen, the toast is always a green
  "확인했어요.", and a Claude 403 on the check counts as unclear and writes nothing (validate.ts, service.ts).

For the owner: an account is only shown as refused when a second, free check agrees; a temporarily blocked Claude
account says so in plain words and comes back by itself; "다시 확인" says what happened.

## Scope

In:

1. **Confirm before marking.** A 401, or an account-level 403, on a model request runs one free check of the same
   account before anything is marked: Claude subscription `POST /v1/messages/count_tokens`, an Anthropic or OpenAI API
   key `GET /models` (validate.ts verifySecret, no tokens spent). One check per account at a time (single-flight, shared
   with "다시 확인" and the background re-check; requests of the same moment wait for it).
   - Check 200 → nothing is marked and no account event is sent; the engine gets a 529 (Claude) / 503 (Codex), which
     its SDK retries on the same account. Retrying never runs a tool twice, unlike switching accounts after a tool ran
     (chat/turn.ts switchCredential refuses a `skip` switch then; plan review finding 2).
   - A refusal of a request sent after that passed check, within 10 minutes, is marked without another check (a
     subscription that ended may still pass count_tokens: decisions/20261118 "Re-check and plan_ended"). A request sent
     before the check finished counts as the same burst (passed).
   - Check refused → marked with the check's own code and answer. Check unclear (5xx, network, timeout) → the original
     answer stands and is marked as before (the background re-check can still bring it back).
   - ChatGPT keeps its own path untouched: its refresh + one retry already is the confirming check (chatgpt-tokens.ts
     single-flight unchanged); codex-path.ts confirms only `openai-api-key` 401s.
   - The "two accounts 403 within 5 minutes = this server" rule stays and runs first.
2. **Separate codes, keep the answer.**
   - confirmed 401 → `upstream_401` (revoked): the row offers "다시 연결하기" (as now).
   - 403 "OAuth authentication/access is (currently) not allowed" → new code `org_oauth_blocked` (API keys keep
     `upstream_403`). Plain detail text: the Claude account's plan or organization is not allowing access right now;
     Trina checks again by itself every few hours, or reconnect another account.
   - other account-level 403s and billing answers keep `plan_ended` / `upstream_403`.
   - The provider's answer is saved in the row's `meta.refusal` = `{ status, type, message, at }`: error type and
     message only, any token-like text, e-mail address and UUID redacted, at most 300 characters, never in logs or
     turn events. `Credential.providerError` (optional, nullable)
     carries it to the screen while the account is refused; the expanded row shows "Claude's answer: 403 permission_error
     · <message>". Cleared when the account works again (check, re-check, new token).
3. **Background re-check.** Every 6 hours (first round 10–20 minutes after start, each round ± up to 30 minutes of
   jitter) refused Claude subscription accounts are checked with count_tokens, one after another, at most 10 per round,
   skipping any checked less than 5 hours ago (`meta.refusal.checkedAt`, so a restart does not check again). Only rows
   that `unusable()` calls `invalid` (so not switched off, kind allowed, sharing on), no gateway, not a free-roam demo:
   - `org_oauth_blocked`: for 30 days after it was marked (team.trina came back after 5 days);
   - `upstream_401`: for 7 days, then left alone (a revoked token is not checked forever);
   - `plan_ended` / `upstream_403` marked before this version (no saved answer): checked once, so the potenlab rows
     stored as `plan_ended` get their real code or come back; after that never (count_tokens may pass for an ended
     plan).
   200 → back to ok only if the row did not change meanwhile (`UPDATE … WHERE status = 'invalid' AND updated_at = ?`),
   code and saved answer cleared, `checked_at` set, audited `credential.recovered`, the owner and admins told at most
   once a day ("'{label}' works again"), open screens refresh. Refused → the saved answer, code and `checkedAt` updated
   (no new notice). Unclear → only `checkedAt`.
4. **"다시 확인" says what it found.**
   - `POST /api/admin/credentials/:id/check` returns the Credential plus `check: { outcome: 'ok' | 'refused' |
     'unclear', reason: string | null }` (optional field; old clients ignore it).
   - A Claude 403 on the check is no longer silent: an account-level 403 marks it (`org_oauth_blocked` /
     `plan_ended`) with the saved answer; any other 403 is outcome `unclear` with the provider's message as reason
     (nothing marked: a region or IP block). Marks go through `store.markInvalid` (saved answer, audit), without the
     notice the admin's own click needs no telling about; ok and a new token clear the saved answer.
   - ChatGPT: a refresh that works brings an account marked `upstream_401` back to ok (the same rule as Claude's
     check); `usage_not_included` stays (a refresh says nothing about the plan).
   - Web: while the check runs the row's badge shows a spinner and "확인 중…" (not inside the closed menu); the toast
     says the result: "연결됐어요." (success) / "여전히 거절됨: <reason>" (error, with a "다시 연결하기" action that
     opens Reconnect/Replace) / "확인 못 함: 잠시 후 다시 해 주세요." (warn).
   - en.ts is the source; ko and the other four languages (check:i18n needs all six).

Out: a new state value in `CredentialState` (a blocked account stays `invalid`, told apart by its detail line and
saved answer); re-checking API keys or ChatGPT in the background (a 401 of a key or a refused refresh token does not
pass by itself); any change to potenlab.trina.app (the deployed build picks this up on its next update).

## Steps

1. Plan (this file), first commit.
2. validate.ts: `verifySecret` returns the provider's error type/message (read from the JSON body, never logged) and
   classifies an account-level Claude 403 as `blocked` with its code; create/replace treat `blocked` as before
   (saved unverified).
3. anthropic-refusal.ts: `org_oauth_blocked` code, export the account-level test and a `providerError()` reader with
   redaction.
4. store.ts: `markInvalid(…, providerError?)` saves `meta.refusal`; `markRecovered()`; `toCredential` gives
   `providerError`; detail text `orgOauthBlocked`; server i18n (6 languages): detail + recovered notice.
5. broker.ts: `confirmRefusal(id)` (single-flight, verifySecret), `onUnauthorized` for non-ChatGPT uses it and returns
   `'skip'` when the check passes.
6. model-proxy.ts 401 / account-level 403 and codex-path.ts OpenAI-key 401: confirm, then skip or mark.
7. service.ts `checkCredential`: outcome + reason, Claude 403 reported/marked, ChatGPT recovery.
8. maintenance.ts: `recheckRefused(cc)` + the 6-hour timer with jitter.
9. shared/src/api/credentials.ts: `providerError`, `CheckCredentialResponse`.
10. Credentials.tsx: badge spinner, outcome toast with action, provider answer in the expanded row; i18n.
11. Decision file `docs/decisions/20261125-ai-account-refusal-recheck.md`; `changes/ai-account-refusal-recheck.md`.
12. Tests (below), QA rows.

## Decisions

New: `docs/decisions/20261125-ai-account-refusal-recheck.md` (confirm before marking, `org_oauth_blocked`, background
re-check). Narrows [20261118-ai-account-failover.md](../../decisions/20261118-ai-account-failover.md) (an account-level 403 is now
confirmed by count_tokens before it is marked; the org-not-allowed one has its own code).

## Risks

- No migration (meta is JSON).
- Extra requests: at most one free count_tokens / GET /models per refusal per account at a time; background at most
  10 per 6 hours. No model tokens spent.
- Secrets: the saved message is the provider's error text, redacted for anything token-shaped and capped; never the
  token, never logged with it.
- A free-roam demo never checks or marks (verifySecret already returns unverified there; store.standIn).
- The engine still gets the upstream's 401/403 as before; only the turn event changes (`skip` instead of `invalid`
  when the check passed), which chat/turn.ts already handles.

## Tests

- tests/unit/anthropic-refusal.test.ts: `org_oauth_blocked` vs `plan_ended`; redaction of the saved message.
- tests/unit/b-credential-failover-kinds.test.ts: 403 org-not-allowed confirmed → `org_oauth_blocked` with the saved
  answer; a 401 whose count_tokens check passes → skipped, not marked, next account answers.
- tests/unit/a-credentials-api.test.ts "check again": outcome ok / refused (+reason) / unclear; Claude 403 org-not-allowed
  marks `org_oauth_blocked`; another Claude 403 is `unclear` with its reason; providerError shown then cleared.
- New tests/unit/a-credentials-recheck.test.ts: the background re-check (recovers on 200, cap, 5-hour skip, refused
  keeps the mark, unclear changes nothing, disabled and other kinds untouched); confirm single-flight.
- web/test/unit: the row shows a spinner while checking and the toast per outcome.
- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, the credential unit tests
  and `bun run test:web`.

## Result

Built as planned (after the plan review): `server/src/credentials/confirm.ts` (single-flight free check, confirm before
marking, background re-check), `org_oauth_blocked` with the saved provider answer (`Credential.providerError`),
`CheckCredentialResponse.check`, and the row spinner + outcome toast. A code review afterwards added: a refusal marked
although its check passed is not re-checked in the background (it would only pass again), a working answer ends the
10-minute hold, a legacy row is checked once even when that check is unclear, and a token replaced during a check is
not marked with the old token's answer. Decision: docs/decisions/20261125-ai-account-refusal-recheck.md. QA TC-9045..9049.

## Plan review (independent subagent, 2026-11-25)

Taken: confirm 401s with a 529 retry instead of a `skip` switch (2), a second refusal after a passed check marks (1, 3),
shared single-flight (3), conditional recovery UPDATE (4), skip sharing-off rows and stop re-checking revoked tokens
after 7 days (5), checkCredential through markInvalid and clearing the saved answer (6), gate the Codex confirm on
`openai-api-key` (7), redact e-mails and UUIDs (8). Not taken as proposed: "mark account-level 403s directly" (1) — the
owner asked for the confirming check on those too; the 10-minute rule bounds the cost, and `plan_ended` rows are not
re-checked in the background after their one legacy check.
