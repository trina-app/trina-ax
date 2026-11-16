# The AI never announces a connect card; it calls connect_service first and says what happened after

- Date (UTC): 2026-11-16 06:14
- Branch: `fix/ai-no-card-announce` (QA TC-3710)
- Status: in progress
- Where: trina-ax core (`server/src/chat/prompt.ts` CONNECT_RULE, `server/src/chat/tools.ts` connect_service description). Why: the AI's instructions are core.
- Version impact: patch. Words only.

## Goal

AI scenario CON-02 (2026-11-16, and 3 of 5 re-runs in #1073): asked to summarise a file in Google Drive that is not set
up, the AI wrote "연결 카드를 띄울게요" (I'll show a connect card) and then called connect_service, which showed no card.
The text is written before the call. CONNECT_RULE invites it: "let the person finish on the card", "offer the card".

## Scope

In: CONNECT_RULE says to call connect_service before writing anything about connecting, never to announce a card (it
shows itself when there is one), and to say what happened only from its result; "offer the card" becomes "call
connect_service again". The connect_service description starts with the same in one short sentence. Other card tools
(post_to_room, share_with_person, delete_files, move/copy) were checked: their rules say what the card does, none asks
to offer or announce one.

Out: removing text the AI already streamed before a call (server side).

## Steps

1. This plan. 2. The words. 3. Unit test. 4. Changes fragment, checks, CON-02 ×5 and CON-03, PR.
