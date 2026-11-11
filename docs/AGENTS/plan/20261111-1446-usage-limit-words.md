# Usage limits: a true USD hint, no empty chat after a refused send, midnight that reads as midnight

- Date (UTC): 2026-11-11 14:46
- Branch: `fix/usage-limit-words`
- Status: done
- Where: `web/src/i18n/*`, `server/src/routes/chats.ts`, `server/src/admin/budgets.ts`, `shared/src`,
  `web/src/components/settings/MyUsage.tsx`. Why: usage limits are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, three bug fixes with no new setting

## Goal

QA TC-215, three small problems with usage limits:

1. Admin › 팀 설정 › 사용 한도 › 한도 추가: the hint under 금액 한도 (USD) says amounts build up only with API key
   connections. Answers through a Claude login count too (the engine reports an estimated amount; QA saw US$4.7), and
   a USD block limit refuses members.
2. A member over a block limit who asks from Home gets the refusal, but an empty untitled chat is made first
   (`POST /api/chats`) and stays in the list.
3. The refusal says "11월 12일 오전 12:00부터 다시 쓸 수 있어요". That can read as noon.

## Scope

In:
1. `budgets.usdHint` in five languages: the amount is an estimate of the same use through the API, and answers
   through a login can add up too.
2. `POST /api/chats` is refused with the same `budget_exceeded` (429, the person's words) while the person's block
   limit is used up. Home's composer then keeps the text and shows the refusal; no chat is made. (Sending, editing and
   regenerating are already refused that way.)
3. One shared formatter for when a limit is free again (`limitResetText`), in 24-hour time: "11월 12일 0시",
   "Nov 12 at 00:00". Used by the refusal (`budgetBlock`) and by Settings › 사용량 (`MyUsage`), which showed
   the same reset time as "오전 12:00".

Out: what the usage page says about costs (`usage.costNote` is right already); other date formats.

## Steps

1. i18n: `budgets.usdHint` ko/en/id/ja/es.
2. `shared/src/limit-reset.ts` `limitResetText(at, locale, timeZone)`, exported from `@mycel/shared`.
3. `server/src/admin/budgets.ts` `budgetBlock` uses it; `server/src/routes/chats.ts` createChat calls
   `checkBudget` first.
4. `MyUsage.tsx` uses it for `resetsAt`.
5. Tests: `tests/unit/b-api.test.ts` (createChat refused and nothing made, the time in 24-hour words), a unit test of
   the formatter, the MyUsage web test if there is one.
6. DECISIONS.md: a short entry.

## Risks

No migration. A person over a block limit can no longer make an empty chat. Attaching files on Home also makes the
chat first, so attaching is refused with the same words. Nothing else needs a new chat without sending. Five languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/b-api.test.ts` and the budget
tests, `bun run test:web`.

## Result

Built as planned. The hint is fixed in five languages. `createChat` calls `checkBudget` first, and Home's composer
keeps the text and shows the server's words through `errorText`. `limitResetText` (`shared/src/limit-reset.ts`) gives
"11월 12일 0시" and "Nov 12 at 00:00" for `budgetBlock` and Settings › 사용량. Tests: `b-api` (no new chat, nothing
made, the same words; the time "…0시부터", never "오전"; this failed before the fix) and `limit-reset.test.ts`.
`bun run test:web`: 2364 pass. `g-subscription`'s managed-mode tests fail on this machine with or without the change
(environment). They do not touch this code.
