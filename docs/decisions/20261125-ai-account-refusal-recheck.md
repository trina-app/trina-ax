# A refused AI account is confirmed by a free check before it is marked, and a blocked Claude account is re-checked by itself

- Date: 2026-11-25
- Status: accepted
- Supersedes: none. Narrows [20261118-ai-account-failover.md](20261118-ai-account-failover.md) ("What counts", "D7/D8,
  narrowed", "Re-check and plan_ended") and the archive's "AI 연결" D14 (one 401 marked the account)
- Branch: fix/ai-account-refusal-recheck (QA TC-9045..9049; plan
  [20261125-0104-ai-account-refusal-recheck.md](../AGENTS/plan/20261125-0104-ai-account-refusal-recheck.md))

- **Ask:** on potenlab.trina.app four Claude subscription accounts showed "거절됨". Two were really revoked (401). Two got
  403 "OAuth authentication is currently not allowed for this organization.", an answer that can pass: team.trina came
  back on a manual re-check five days later with the same token. "다시 확인" showed nothing either way.
- **Cause:** one 401 on a model request marked the account refused for good with no second look (D14); the
  org-not-allowed 403 was stored as `plan_ended` ("subscription ended"); nothing re-checked a refused account; the
  provider's words were not kept; "다시 확인" closed its menu at once, always toasted a green "확인했어요.", and a Claude
  403 on count_tokens was "unclear" and wrote nothing.
- **Rule: confirm before marking** (`server/src/credentials/confirm.ts`). A 401, or an account-level 403
  (`proxy/anthropic-refusal.ts`), on a model request runs one free check of the same account first: count_tokens for a
  Claude subscription, `GET /models` for an Anthropic or OpenAI key. One check per account at a time; "다시 확인" and the
  background re-check share it.
  - The check passes: nothing is marked and no account event goes to the turn. The engine gets a 529 (Claude) / 503
    (Codex) and its SDK retries on the same account. A retry never runs a tool twice; moving the turn to another
    account after a tool ran is what `skip` refuses (chat/turn.ts).
  - A refusal of a request sent after that pass, within 10 minutes, is marked without another check: an ended plan may
    pass count_tokens. A request sent before the check finished belongs to the same burst.
  - The check refuses: marked with the check's own code and answer. No clear answer (5xx, network): the answer seen
    stands and is marked as before.
  - ChatGPT is unchanged: its single-flight refresh and one retry are its confirming check. Billing answers (402/400)
    are marked as they come. The "two accounts 403 within 5 minutes = this server" rule runs first, as before.
- **Rule: codes and the answer.** A confirmed 401 stays `upstream_401` (the row offers Reconnect). The org-not-allowed
  403 is `org_oauth_blocked`: "this Claude account's plan or organization is not allowing access right now; Trina checks
  again every few hours". Other account-level 403s keep `plan_ended` / `upstream_403`. The provider's status, error type
  and message are kept in the row's `meta.refusal` (cleaned: no token-like text, e-mail address, UUID or `org_`/`req_` id;
  at most 300 characters; never in logs or turn events) and shown in the opened row (`Credential.providerError`). Working
  again (a check, the re-check, a new token) clears it.
- **Rule: background re-check.** About every 6 hours (first round 10–20 minutes after start, ±30 minutes each), at most
  10 refused Claude subscriptions a round, one after another, with count_tokens only. Only rows refused for no other
  reason (not switched off, kind allowed, sharing on), no gateway, not a free-roam demo, not checked in the last 5 hours.
  `org_oauth_blocked` is asked for 30 days, `upstream_401` for 7 days; a `plan_ended` / `upstream_403` marked before this
  version (no saved answer) once, then never (count_tokens may pass for an ended plan). A 200 sets it back to ok only if
  the row did not change meanwhile, audits `credential.recovered` and tells the owner and admins at most once a day.
- **Rule: "다시 확인" says what it found.** The API adds `check: { outcome: ok | refused | unclear, reason }`
  (`CheckCredentialResponse`, optional for older clients). A Claude account-level 403 on the check marks it (no notice to
  the admin who pressed it); any other Claude 403 is `unclear` with the provider's words. The web shows a turning badge
  on the row while it runs and one toast: "연결됐어요." / "여전히 거절됨: <reason>" with 다시 연결하기 (or 키 바꾸기) / "확인 못 함:
  잠시 후 다시 해 주세요.".
- **Left out:** a new `CredentialState` (a blocked account stays `invalid`, told apart by its line and saved answer);
  background re-checks of API keys and ChatGPT (their refusals do not pass by themselves).
- **Tests:** tests/unit/a-credentials-recheck.test.ts, tests/unit/b-credential-failover-kinds.test.ts,
  tests/unit/a-credentials-api.test.ts ("check again says what it found"), tests/unit/anthropic-refusal.test.ts,
  web/test/unit/credential-check-again.test.tsx.
- **Version impact:** patch: fixes accounts wrongly shown as refused and a re-check that showed no result; no new
  setting, no migration, the API only gains optional fields.
