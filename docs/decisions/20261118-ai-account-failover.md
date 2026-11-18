# An account's own refusal on /v1/messages moves the answer to the next account

- Date: 2026-11-18
- Status: accepted
- Supersedes: none. Adds to the archive's "AI 연결" D14/D15 and narrows D7/D8 for `/v1/messages` only
- Branch: fix/ai-account-failover (the owner, QA TC-4835)

- **Ask:** an answer failed with "There's a problem with the AI account" while two accounts showed "Healthy". One of
  them was a Claude subscription that had ended, and it still showed "Healthy".
- **Cause:** D14 marked a connection only on a 401 (refused) or a long 429 (limit), and D15 moved a turn only on those
  marks. Anthropic answers an ended subscription with a 403 or a billing answer, not a 401. The proxy passed that answer
  on unchanged, the engine reported it as a sign-in problem (`auth`), and the turn ended with no switch and no mark. Every
  later turn picked the same account first again, because it still looked usable.
- **What counts as Anthropic's answer:** only an answer to `POST /v1/messages` (never `count_tokens`), in Anthropic's
  error shape (`{"type":"error","error":{"type":…}}`) with a `request-id` header, from `api.anthropic.com` itself (or a
  loopback test upstream). An edge or Cloudflare page, a company proxy, a gateway or another custom upstream never marks
  an account.
- **Rule** (`server/src/proxy/anthropic-refusal.ts`):
  - 403 with `error.type` `permission_error` or `authentication_error` and a known account-level message (organization
    or account disabled, no access to Claude Code, Claude Code not in the plan, OAuth access not allowed, OAuth token
    revoked): a Claude subscription account is marked refused with `plan_ended`; an API key with `upstream_403`.
  - Any other 403 from Anthropic (a region, an unexplained permission): the account is skipped for the rest of the turn.
    Nothing is marked, and the next turn tries it again.
  - A burst of account-level 403s on different accounts is probably this server's problem (its region or IP): the first
    account in the burst is marked, and any other account that gets one within 5 minutes of it is only skipped, not
    marked.
  - 402 or 400 with `error.type` `billing_error`, or the exact phrase "credit balance is too low" (nothing looser, like
    the Codex path's `isCreditLimit`): a Claude subscription account is marked `plan_ended`. An API key is held out for an
    hour with its own reason, `no_credit` (state "Out of credit", detail "Out of API credit. Add credit at Anthropic…").
    That hold is not a rate limit: it has no retry time, it never makes the turn's error `rate_limited`, and it never
    starts the "Answer with the other AI" (Codex) fallback.
  - Other 400s, 404, 5xx and network failures change nothing and do not switch: they are the request's or the service's
    fault.
  - A Claude turn whose engine reports `auth` while the proxy recorded no refusal skips that account for the rest of the
    turn without marking it. Only the proxy's reading marks an account.
  - A skip that is not a mark (an unexplained 403, an engine `auth` error) happens only if the attempt has called no tool
    yet, so a tool never runs twice on another account. It counts against the same cap of two switches per turn (D15).
  - `auth` from the engine needs the error class or the leading text (`authentication_error`, `Failed to authenticate`,
    `API Error: 401`, …). A "401" inside a request id no longer counts.
  - The proxy's own refusals (its forwarding rules, the peer check, a token for the other path) tell the turn so
    (`refused` event). The engine's error after one (Claude Code words it "Failed to authenticate. API Error: 403 …")
    then ends the answer with the safety-stop message, with no account switch and no mark.
- **D7/D8, narrowed:** a 403 to `count_tokens` (the free check that Add account and Re-check use) stays "unclear" for a
  Claude subscription token, as before. Only a 403 on `/v1/messages` that matches the rule above marks the account.
- **Re-check and `plan_ended`:** Re-check uses the free `count_tokens` call. If it passes, the account is set back to ok
  (an ended subscription may still pass, and its next real request marks it again). If it answers 403, the account stays
  marked. The way out of an ended subscription is to reconnect an account with an active one, or remove it.
- **Re-check and `no_credit`:** a pass ends the out-of-credit hold too (status code and hold time), so it never stays as
  a bare limit. A key that is still out of credit is held again by its next request.
- **State line:** `plan_ended` shows as "Refused" with "Claude refused this account: its subscription ended or its plan
  does not include Claude Code. Reconnect an account with an active subscription, or remove it."
- **Left out:** no background health check of idle accounts. A status still changes only when an account is used.
- **Order of use** is unchanged and fixed, not rotating: tier (own, person, group, team-wide), then the list order
  (Move up / Move down set `priority`), subscriptions before API keys, then the date added. Accounts that are switched off,
  refused, expired, out of credit or at a limit are skipped. Codex answers for Claude only when "Answer with the other
  AI" is on and the error is a limit. A refusal never falls back to Codex.
- **Tests:** `tests/unit/anthropic-refusal.test.ts` (the table and the upstream rule),
  `tests/unit/b-credential-failover-kinds.test.ts` (the owner's four accounts, each kind of answer through the real proxy
  and a fake engine, the out-of-credit hold, the turn-side skip with its two-switch cap and the no-tool-call rule, the
  server-wide 403 rule).
- **Version impact:** patch.
