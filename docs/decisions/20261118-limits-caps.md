# Per-answer caps and prompt cuts closer to Claude Code

- Date: 2026-11-18
- Status: accepted
- Supersedes: the numbers in docs/DECISIONS.md "Tool rounds per answer" (default 150) and the 10 × 4,000 rule-file,
  16,000 skill and 300 / 4,096 memory limits of the first prompt (2026-10-21)
- Branch: fix/limits-caps (QA TC-4902, TC-4903, TC-4908)

Plan: docs/AGENTS/plan/20261118-1042-limits-caps.md.

Goal from the owner: the AI should behave like Claude Code. Claude Code has no write cap or round cap per answer, loads
CLAUDE.md and SKILL.md whole, and does not cut them without a word.

## make_file's PowerPoint limits only with safe operations

"Limits: 30 slides, 20 images, 100,000 text characters", "uploaded templates are deferred" and expected_layouts are
checked only with safe operations on (`MYCEL_SAFE_OPS_1A`, safe-ops/presentation.ts). The sentence is now in the
description only then. Without safe operations a deck has no slide or picture cap.

## Writes per answer: 1 GB and 2,000 files; guests 50 MB and 200

The 50 MB / 200 files per answer was the disk guard of 2026-10-21. The disk is now kept by system/storage.ts
assertStorageRoomForAI on every save of the AI: on Linux and wherever a plan applies, the plan's guard (reserve, cap,
grace period); everywhere else (a Mac without a plan: the Office Mac, the desktop app), where that guard does nothing,
a simple floor: the save is refused when it would leave less than max(2 GiB, min(5% of the disk, 10 GiB)) free (fresh
statfs of the team folder). The 10 GiB cap came in the 11-18 batch: without it a 1.8 TB disk with 91 GB free (5% is
92 GB) refused every AI write. It is the one reserve rule (system/disk-stat.ts diskReserve), also used by save_url and
the speech model's download, which kept 10% (5 to 20 GiB) before. So these numbers only stop an AI writing in a loop.
The ops checks' read-only line on the Mac rule (system/storage.ts absoluteFloor, also the storage card's `full`, QA
TC-209) had the same missing cap, max(10 GiB, 5%): a big disk 95% full showed as read-only while writes still worked.
It is now max(10 GiB, min(5%, 10 GiB)) (11-19 batch; tests/unit/g-linux-diag.test.ts "the Mac rule",
tests/unit/full-disk-words.test.ts).
Members: 1 GB and 2,000 files (`maxWriteBytesPerTurn`, `maxFilesWrittenPerTurn`). Guests keep 50 MB and 200
(`guestMaxWriteBytesPerTurn`, `guestMaxFilesWrittenPerTurn`); one helper, files/turn-write-limits.ts, picks the pair by
person (users.guest), for every check (files service, make_file's placeProduced, unzip_file for a guest, safe-ops
publication). At the limit the refusal is the same: say what was saved and ask the person to say "continue".

## Tool rounds per answer: default 500; guests at most 150

`DEFAULT_ANSWER_STEP_LIMIT` is 500 and the admin range is 10–2,000 (was 10–500), so an admin can still go above the default. A team that saved another number keeps it. A guest's
answers take at most `GUEST_ANSWER_STEP_LIMIT` (150) whatever the team setting, or the team's number when lower. So
does a run nobody watches (`UNATTENDED_ANSWER_STEP_LIMIT`, 150): a scheduled task's run (clientKind 'schedule') and a
question asked from Slack (or a chat of a Slack thread), where nobody can press Stop on a run that goes on. Room apps
start no AI runs. A chat someone watches gets the team limit (default 500). One function, chat/turn.ts answerStepCap. At the
limit nothing new is needed: the answer already ends with "This task ran long, so it paused here" and a **Continue**
button (stopReason `tool_limit`, web Messages.tsx), which resumes the same session. The API engine's own 30 rounds and
sub-agents' 50 are other items.

## Team rule files, skills and memories: bigger, and never cut without a word

| What | Before | Now |
|---|---|---|
| Rule files (skills/*.md without a header) | first 10, 4,000 characters each | first 50, 20,000 each, 100,000 in all |
| A skill's steps | 16,000 characters | 100,000 characters |
| A skill or rule file | 128 KB | 512 KB (room for 100,000 Korean characters; skill shares follow, still 1 MB per skill) |
| A skill loaded with the skill tool | 16,000 characters | below the cut of the engine the turn runs on (also after a Claude limit moved it to Codex) (SKILL_TOOL_LIMIT): Claude Code 22,000 tokens (it cuts at 25,000), Codex 8,000 tokens (its model catalog cuts at 10,000), the API engine 26,000 characters (it cuts at 30,000) |
| One memory | 300 characters | 1,000 characters (`MEMORY_TEXT_MAX`, the same for the AI's remember and Settings) |
| The memory block | 4,096 characters | 32 KB |

Every cut now says so in the prompt and how to go on. The notes are for the AI only: each ends with "This note is for you only: read on quietly when the work needs it and do not tell the user that anything was cut or left out" (`QUIET_CUT_NOTE`), because the first real-AI run told the person "The handbook was truncated; read the rest."

- a rule file longer than 20,000 characters: "(Cut here: <path> has N characters and only the first 20,000 are given to you.
  Read <path> with the read tool for the rest ...)";
- rule files past the 100,000-character budget are named, with "They are rules all the same: read the ones that fit the
  work with the read tool before you start";
- more than 50 rule files: the count (as before), now with "List skills/ and read the rest with the read tool";
- a skill cut at 100,000 characters, or at 22,000 tokens in the skill tool's result: "(Cut here: this skill has N
  characters and only the first M are given to you. Read <path> with the read tool for the rest ...)";
- memories past the 32 KB block: "Older memories are kept but not shown here ...; they see every memory in Settings"
  (Settings already marks them "Not used").

The Trina AX MCP guide and skills_list name the rule files past the budget too (they are followed rules).

## The prompt budget against the model's context

The team rules and the memories take at most a quarter of the model's context, and a "/skill" its own eighth beside it
(prompt.ts `promptBudget`, `contextTokensFor`): Claude Code 200,000 tokens (1,000,000 for a "[1m]" model), Codex
272,000 (its catalog), the API engine 32,000 when its address is this machine or the local network (a local model),
else 128,000. The memory block takes at most 40% of the quarter and the rules the rest, counted in tokens (files/vision.ts
textTokens). The skill never takes from the rules and memories: a resumed Claude session keeps the rules of its first
instructions, so a chat started with a skill would keep fewer rules for good (review of #1284). Each cut keeps the usual note (read the rest, quietly). For a
Claude model that is 50,000 tokens: English rules and memories at their maximum fit; Korean ones are cut earlier
(about 30,000 characters of rules and 20,000 tokens of memories). Settings › Memory marks "Not used" by the budget of the engine and
model a new chat of the person starts on (admin/engine-choice.ts personalDefault).

Why a total budget for rules: 50 × 20,000 would be up to a million characters in every request of every answer. 100,000
characters is 2.5 times Claude Code's own "large CLAUDE.md" warning (40,000), and the files past it are still named, so
nothing is lost.

## What it costs

Measured with files/vision.ts textTokens (4 ASCII characters a token, any other character a token; Korean text in the
real tokenizer is a little cheaper). Only teams with long rules or many long memories pay more; a team with a few short
rule files and memories sends the same prompt as before.

| Worst case | English | Korean |
|---|---|---|
| Rule text, before → now | 10,000 → 25,000 tokens | 30,000 → 76,000 tokens |
| Memory block, before → now | 1,000 → 8,000 tokens | 3,000 → 25,000 tokens |
| A used skill, before → now | 4,000 → 25,000 tokens | 12,000 → 76,000 tokens (22,000 through the skill tool) |

The rules and memories are in the instructions, which Claude Code caches. Worst case English, +22,000 tokens a request:
on Claude Sonnet 5.5 about $0.055 once per answer to write the cache and $0.002 a round after; worst case Korean,
+68,000 tokens: about $0.17 once and $0.007 a round (Claude Opus 5.5 twice that). The other cost is room: a Korean team
at every maximum gives about 100,000 tokens of the context to rules and memories before the conversation starts.

## Left for later

- The API engine's 30 rounds, sub-agent rounds, the image budget and the 40,000-character history are other items.
