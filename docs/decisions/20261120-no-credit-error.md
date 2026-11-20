# "Credit balance is too low" is its own error, with who fixes it

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (follows "Plain words in errors, cards and steps" in the [archive](../DECISIONS.md), as AP-071's
  `provider_busy` does)
- Branch: qa/1120-admin (AI parity QA leftover LEFT-2)

- **Ask:** Claude Code's "Credit balance is too low" read "The answer stopped partway. Please try again.", though a retry
  fails the same way.
- **Rule:** `classifyError` reads "credit balance is too low" or `billing_error` as `no_credit` (a new
  `EngineErrorCode`), code `engine_unavailable` (no usage-limit fallback: it is not a limit). A member reads that the AI
  account is out of credit, that trying again won't help, and to ask an admin to add credit or switch to another AI
  account; the owner and admins read to add credit with the provider or switch account in Admin › AI providers (the
  path filled in, as `credential_unusable`). Every locale. The file-list reader treats it as unavailable, like a
  sign-in error. The proxy's own reading of an API key out of credit (switch to the next account) is unchanged.
- Try again stays on the answer: once credit is added it works.
- Tests: `tests/unit/anthropic-refusal.test.ts`, `tests/unit/b-chat.test.ts`, `web/test/unit/chat-error-words.test.ts`.
- Version impact: **patch** (a new error reason; older apps show its stored text).
