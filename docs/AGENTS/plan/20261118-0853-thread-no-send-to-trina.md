# Remove the "Send to Trina" row from the chat thread panel

- Date (UTC): 2026-11-18 08:53
- Branch: `chore/thread-no-send-to-trina`
- Status: done
- Where: web/ (chat thread panel), shared/, server/ prompt words. Why: the owner wants the row gone (QA TC-4866) (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a button is removed

## Goal

Under the reply box of a thread under an AI answer there is no "Send to Trina - You can edit it before sending" row. The box and the one-line note stay, with no empty gap.

## Scope

In: the button, its draft builder, the chat page wiring, the four i18n keys in six languages, the AI's app map and prompt mentions, their tests and docs.
Out: the @mention picker, the quote gates, `Composer.prepareDraft` (other callers), the `answer_comments` tool.

## Steps

1. Remove the row and `onSendToTrina`; drop `chatThreadDraft` and its keys; fix prompt/app-map words and tests.
2. Update the e2e specs and docs; add the decision and a changes note.

## Decisions

`docs/decisions/20261118-thread-no-send-to-trina.md` (supersedes one line of the 20261116 threads decision).

## Risks

The AI's prompt no longer names a button. The phone app has no such row.

## Tests

typecheck, check:i18n, check:docs, check:prepush, web unit chat-threads, server b-chat-threads, b-ai-share-words, ai-app-map, e2e chat-threads.

## Result

Removed the row, its draft builder, the chat page wiring, four i18n keys in six languages, the AI map and prompt mentions of the button and their tests; the specs and docs follow. The phone app has no such row. Checks: check:prepush, web unit and server unit tests, e2e chat-threads (9 pass).
