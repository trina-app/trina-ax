# Batch 3 follow-ups: no rule reasoning in answers, lost access said after a search, one computed number

- Date (UTC): 2026-11-22 14:37
- Branch: `fix/answer-reasoning-access-numbers`
- Status: in progress
- Where: server/src/chat (turn.ts, prompt.ts, tools.ts, chat-file-tool.ts, file-notes.ts). Why: three QA findings of
  batch 3 where the AI's words are wrong or show its own reasoning (docs/REPOSITORY-RULES.md).
- Version impact: patch. How answers are kept and what tool results say; no API, setting or schema change.

## Goal

QA rows (sheet "QA"): qa batch 3 flow 2 (no row id; shot ~/qa-qab3-shots/f2-m1-refine-390.png), TC-b3s-22 (S-118),
TC-b3s-7 (S-102).

1. **Rule reasoning in an answer.** QA Member asked for a darker red in a shared chat written in English. The saved
   answer starts: "Same requester (QA Member) changing their own red, so just do it. #c81e1e → darker, e.g. #9b1515".
   The QA server's row shows the order: a page read (step at 0), that text (113 characters), the page edit (step at
   113), a thinking block, then the reply. So the line is **interim text before a tool call**, kept because the person
   wrote in Latin letters: #329/#364 take interim text out only where the answer is Korean, Japanese or Chinese
   (decision 20261122-interim-text-not-answer: "English … stays, as in Claude Code"), and #371 only looks at the
   leading paragraphs of a CJK final answer. Its words come from the prompt: #373's shared-chat line ends "No question
   when {name} only changes their own earlier request …: just do it."
2. **S-118 (TC-b3s-22).** After 박준호 left 영업, "단가표에서 B형 가격도 넣어줘" and a probe "영업 폴더 단가표.xlsx 다시
   열어서 …" got "영업 폴더를 검색할 수 없어서 … 경로를 알려 주세요". The probe's steps (b3s log d-s118f.out): glob without
   a path (refused in a people-shared chat: "Not searched: … needs a folder. Name one of …"), glob in shared, glob in
   groups/마케팅, list shared, list /, list groups, grep shared. #389's `lostAccessFor` speaks only on a refusal "not found
   or no access" of a path in the lost place, or on a glob/grep whose scope covers it. None of these calls is that: the
   path-less glob was an error of another kind, and only list (not a search tool) looked above groups/영업. So the fact
   never reached the AI, and the shared-chat prompt line told it to "ask for its path".
   Also: the first turn's read of 박준호's own quote (users/junho/견적서_카페체인.xlsx, made by this chat's AI before the
   chat was shared) got the card "AI가 내 개인 폴더를 읽으려고 해요". The QA harness shared the chat by the API without its
   files. In the app the Share dialog offers "share the files from this chat too" (ticked by default), which copies
   the quote into the chat (chat-files-share.ts, origin `shared-copy`); the read of the original still asked.
3. **S-102 (TC-b3s-7).** The chat answer said the top 3 had "약 77.6%"; the page it made computes 66.9% (25.5/38.1) from
   its own data. The page also showed only "출처: …xlsx", no as-of date.

## Scope

In:

1. **Interim text leaves every answer, not only CJK ones** (turn.ts endPiece). A text piece of the main AI that a
   tool call of the main AI follows becomes a thinking step in every language, with the same exceptions as today:
   bookkeeping calls (title, to-do, remember/forget) end no piece, a piece copied into the call's arguments stays, a
   sub-agent's calls do not end it, and the last interim piece is the answer when nothing follows the last call.
   The pattern filter (narration.ts) and the CJK lead rule (#371) stay as they are. New decision file narrowing
   20261122-interim-text-not-answer.
   **Prompt:** one general line in every turn (next to ACT_FIRST_RULE): the answer is for the people; never write which
   instruction applies or why you ask or act ("same requester, so just do it", "no conflict, so no question"), before
   a tool call either. #373's line ends on "do it without asking" with no "just do it" to echo, and so does
   ACT_FIRST_RULE's wording where it invites the same. Prompt pins updated.
2. **S-118: the lost place is said after any look that should have found it** (chat/tools.ts lostAccessFor):
   - a search refused for having no path in a shared chat (the people chat's "Not searched: …" or the project chat's)
     counts as a search of everything (scope ''), so the lost place is said once;
   - `list` of a folder above the lost place (/, groups) counts like a search of that folder;
   - nothing else changes: the note is still decided on the folder rules and this person's own earlier reads only.
   - sharedSection's "not found by a search without a path … ask for its path" line gets "unless a tool result says it
     can no longer be opened: then say only that".
   - **Own quote card:** a read of a file in the person's own folder whose bytes are those of a `shared-copy` of it in
     this chat, on an answer nobody here is kept from, reads as the chat's (no card): everyone here already opens those
     exact bytes. A share made without the files keeps the card (the creator chose not to share them).
3. **S-102: one number, and the data's date.**
   - Prompt (FIGURES_RULE): a number stated in the answer about a file or page you made comes from the same
     computation as that file (compute once, in a command or in the page's own data, and copy that value); never work
     it out again in your head. A page, chart or report made from a data file shows the data's as-of date next to its
     source.
   - Tool fact: a read of a spreadsheet or CSV team file (main AI, not an error) gets one line with the file's last
     change in the team's shown time zone, once per file a turn: "This file was last changed 2026-11-22 14:03
     (Asia/Seoul): a page, chart or report made from it shows that as its data date." (chat/file-notes.ts)

Out: the CJK lead rule for English answers (no structural signal there; the prompt line covers notes after the last
call); live re-reading of a page when its source changes (TC-r2u-18's "did not change by itself" is as designed).

## After the plan review (2026-11-22)

- Interim in every language: the "copied into the call" check now runs in every language too (it was gated on the
  same flag), and the fallback skips status lines in English as well (NarrationHold.isStatusLine). A piece before an
  ask_user card goes as in Korean. The English tests that pinned the old behaviour flip; the full tests/unit runs.
- Prompt: no example phrases in the new line (quoted, they get echoed); #373's line ends "do it, and say only what you
  did". The new line stays, short: it is the only guard for a note after the last call in an English answer.
- lostAccessFor: a sub-agent's call gets the line but does not use up the main AI's once a turn. Only people-shared
  chats refuse a path-less search (a project chat's stays in the project folder): the plan's "or the project chat's"
  was wrong. A refused search and a later "not found" there can both say it in one turn; a later turn's list of "/"
  says it again (the person read that place in this chat).
- Data date: the time names its zone (the person's shown zone, as other tool results), and is the newest file event's
  time while the bytes are still that event's, else the time on disk.
- **Own quote card: cut.** With the chat shared with its files, a main-AI read of the original is already mapped to
  the chat's copy before any card (mapPaths). The QA run shared by the API without the files, where the card is right:
  the creator did not share the quote.

## Steps

1. This plan; independent plan review; apply.
2. turn.ts endPiece in every language; narration tests (the English test flips), a test for the QA line.
3. Prompt line + #373 wording + FIGURES_RULE; prompt pins.
4. lostAccessFor: refused path-less search, list above; prompt line; tests in the S-118 test file.
5. Shared-copy read as the chat's (chat-file-tool.ts + turn.ts sharedSources); test.
6. Data-date note (file-notes.ts, tools.ts); test.
7. changes/answer-reasoning-access-numbers.md, decision file.
8. typecheck, check:prepush, area tests on the Mac mini (Bun 1.3.12); real claude-code A/B on a private QA copy
   (flow 2 English refine x2, S-118 x2, S-102 x2, before/after); independent code review; one PR to dev, not enqueued.

## Decisions

docs/decisions/20261122-interim-text-every-language.md: text a tool call follows is interim in every answer
language (narrows 20261122-interim-text-not-answer, which kept English interim text in the answer).

## Risks

- English answers that put content before a call (a draft, then a save) now lose it to a thinking step unless the
  call carries it (copied) or nothing follows the last call (fallback). Korean answers have had this since 11-22.
- The lost-access note must still never name a place this person did not read in this chat (unchanged).
- Shared-copy read: only exact bytes already in the chat, visible to everyone here; fails closed.
- Prompt pins (engine prompt tests) change in the same commit. No migration, no new UI string.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit narration-hold, final-answer-lead, the S-118 lost-access
tests, shared read card tests, prompt pin tests, file-notes tests (Bun 1.3.12, Mac mini).

## Result

(at the end)
