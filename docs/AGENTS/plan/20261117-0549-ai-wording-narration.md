# English work notes before a tool call stay out of Korean, Japanese and Chinese answers (second rule)

- Date (UTC): 2026-11-17 05:49
- Branch: `fix/ai-wording-narration`
- Status: done
- Where: server/src/chat. Why: the notes are text pieces of the answer stream, which chat/narration.ts holds for chat/turn.ts.
- Version impact: patch, a fix in which text pieces the answer keeps; no API, data or prompt change

## Goal

After #1066 (decision 20261116-answer-no-english-narration), Korean answers still start with short English notes the
model writes to itself before a tool call: "Find the price list first.", "Need to find the CSV/scan.", "Only one
thread; read it." (QA TC-3702, TC-3711, TC-4291, TC-3821; scenario cases ROOM-03, ORG-01, EDIT-04, FL-19, FL-25,
SKL-01.member). #1066 drops only lines that open like a status line ("Let me check …"). A prompt change measured on
11-17 did not help (13–14 of 207 answers still leaked).

## Scope

In: the hold in chat/narration.ts. Position stays the main rule: only a piece the main AI writes right before its own
tool call can be dropped, never the last piece (the answer after the last call), and only in a ko/ja/zh answer with no
request for another language. New: such a piece is also a note when it names the work (a file, a folder, a thread, a
page, a skill …), gives itself an order or a plan, or talks about "the user", unless it speaks to people (you, we,
hi, please …), is an order said to people, reports to the person (I can't, I didn't, I used …, "… says"), is a title,
or is copied into that call's arguments (a message it posts, a file it writes) or taken from the person's message. "page 2 first" is no
longer read as a number with a unit. Work notes are judged only before a real call (not on thinking, a stop or an
error).
Out: notes in the answer's own language; notes with measurements ("191mm + 15mm"), notes in another Latin language
(German); showing dropped notes in the steps area (kept simple: dropped, as in #1066). 0 prompt tokens.

## Steps

1. Failing tests: the 11-17 leaked lines dropped before a call and kept as the last piece; copied into the call's
   arguments or the person's message = kept; content that names work things but speaks to people = kept; the 55 probe
   lines of #1066's reviews stay kept.
2. chat/narration.ts: isWorkNote, REPORT, copied(); toolStart(input); NarrationHold(script, message).
3. chat/turn.ts: pass the person's message and the call's arguments.
4. Decision file, changes fragment.
5. Real-AI check (Sonnet subagent, runner from test/ai-scenarios, relay on): the leaking cases plus a 60+ case Korean
   sample, 3 runs, before (dev) and after; leak counts and real content lost (must be 0).

## Decisions

docs/decisions/20261117-answer-work-notes.md

## Risks

A short English line that names a work thing, written right before a call in a Korean chat without asking for English
and not copied into the call (an English sentence shown, then something else done): dropped. Safeguards: the last piece
is never touched, people words, report words, titles, Markdown, links, quotes and numbers with units keep a line.

## Result

Real AI (Claude Code engine, relay on, runner from test/ai-scenarios), 82 Korean cases (the 20 leaking cases and a
62-case sample) + flows FL-19, FL-25, 3 runs each side:
- before (dev fed7a4a5e): 9 / 9 / 9 Korean answers with an English work note; FL-19 1 / 1 / 1.
- after (this branch): 0 / 0 / 1 (ROOM-03.reply: "This is the only thread about Saturday delivery, so I'll post the reply
  there."); flows 0 / 0 (third flow run skipped).
- dropped pieces after: 34, all notes; real content lost: 0.
Two independent reviews; both rounds of findings fixed (work notes only before a real call, note shape required for a
named work thing, words said to people and warnings kept, copy check tolerant of small edits).
