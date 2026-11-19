# The others' copy of a shared answer scans each piece once

- Date (UTC): 2026-11-18 22:36
- Branch: `fix/others-text-linear-scan`
- Status: done
- Where: Team AX core, `server/src/chat/live-answer.ts` (OthersText). Why: the live text of shared chats is core.
- Version impact: patch (CPU cost of a running shared answer; nothing changes for the user)

## Goal

QA TC-4970: `OthersText.of` (#1311) scanned the whole held run of secret-form characters again for every piece of the
answer. A 64 KB run sent in 7-character pieces cost about 770 ms of CPU (1.4 s measured here).

## Scope

In: remember how far the text was scanned and where the run at its end starts; scan only the new characters. Out:
anything else of the live answer.

## Steps

1. `redact.ts formChars`: the characters a written form is made of (formRunLength's set), built once per redactor.
2. `OthersText`: `seen` and `runAt`; start over when the redactor changes, the text gets shorter than what was
   scanned, or the part let out changed.
3. Test: a 64 KB run in 7-character pieces under 200 ms (`tests/unit/others-text.test.ts`); the secret-hiding tests
   stay green.

## Decisions

none

## Risks

Security: what the others get must stay the same (the padded-entity and other secret tests).

## Tests

`bun run check:prepush`, `tests/unit/others-text.test.ts`, `tests/security/shared-chat-live.test.ts`, the shared-chat and
secret suites.

## Result

As planned. The old scan takes about 1.4 s for the timing test, the new one a few milliseconds.
