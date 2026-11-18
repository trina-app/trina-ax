# An account's own 403 or billing refusal moves the answer to the next account

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (adds to the archive's "AI 연결" D14/D15)
- Branch: fix/ai-account-failover (the owner, QA TC-4835)

- **Ask:** an answer failed with "There's a problem with the AI account" while two accounts showed "Healthy". One of
  them was a Claude subscription that had ended, and it still showed "Healthy".
- **Cause:** D14 marked a connection only on a 401 (refused) or a long 429 (limit), and D15 moved a turn only on those
  marks. Anthropic answers an ended subscription with a 403 or a billing 400, not a 401. The proxy passed that answer
  on unchanged, the engine reported it as a sign-in problem (`auth`), and the turn ended with no switch and no mark. Every
  later turn picked the same account first again, because it still looked usable.
- **Rule:** from Anthropic itself (not a gateway, whose 403 can be its own moderation):
  - 403, any type: a Claude subscription account is marked refused with `plan_ended`; an API key with `upstream_403`.
  - 400 that names billing, credit, a subscription or a plan (or type `billing_error`): a Claude subscription account is
    marked `plan_ended`; an API key is kept out for an hour like a credit limit (`credit_balance_exhausted`, as on the
    Codex path).
  - Other 400s, 404, 5xx and network failures change nothing and do not switch: they are the request's or the service's
    fault.
  - A Claude turn whose engine reports `auth` while the proxy recorded no refusal skips that account for the rest of the
    turn (at most the two D15 switches) without marking it, since only the proxy's reading marks an account.
- **State line:** `plan_ended` shows as "Refused" with "Claude refused this account: its subscription ended or its plan
  does not include Claude Code. Reconnect an account with an active subscription, or remove it."
- **Left out:** no background health check of idle accounts (a status still changes only when an account is used or
  checked); Re-check stays on the free count_tokens call, which may still pass for an ended subscription.
- **Order of use** is unchanged and fixed, not rotating: tier (own, person, group, team-wide), then the list order
  (Move up / Move down set `priority`), subscriptions before API keys, then the date added. Accounts that are switched off,
  refused, expired or at a limit are skipped. Codex answers for Claude only when "Answer with the other AI" is on and the
  error is a limit, never after a refusal.
- **Tests:** `tests/unit/anthropic-refusal.test.ts` (the table), `tests/unit/b-credential-failover-kinds.test.ts` (the
  owner's four accounts; each kind of answer through the real proxy and a fake engine).
- **Version impact:** patch.
