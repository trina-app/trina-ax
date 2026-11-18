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

The 50 MB / 200 files per answer was the disk guard of 2026-10-21. The disk floor (system/storage.ts
assertStorageRoomForAI) now protects the disk on every save, so these numbers only stop an AI writing in a loop.
Members: 1 GB and 2,000 files (`maxWriteBytesPerTurn`, `maxFilesWrittenPerTurn`). Guests keep 50 MB and 200
(`guestMaxWriteBytesPerTurn`, `guestMaxFilesWrittenPerTurn`); one helper, files/turn-write-limits.ts, picks the pair by
person (users.guest), for every check (files service, make_file's placeProduced, unzip_file for a guest, safe-ops
publication). At the limit the refusal is the same: say what was saved and ask the person to say "continue".

## Tool rounds per answer: default 500; guests at most 150

`DEFAULT_ANSWER_STEP_LIMIT` is 500 and the admin range is 10–2,000 (was 10–500), so an admin can still go above the default. A team that saved another number keeps it. A guest's
answers take at most `GUEST_ANSWER_STEP_LIMIT` (150) whatever the team setting, or the team's number when lower. At the
limit nothing new is needed: the answer already ends with "This task ran long, so it paused here" and a **Continue**
button (stopReason `tool_limit`, web Messages.tsx), which resumes the same session. The API engine's own 30 rounds and
sub-agents' 50 are other items.

## Team rule files, skills and memories: bigger, and never cut without a word

| What | Before | Now |
|---|---|---|
| Rule files (skills/*.md without a header) | first 10, 4,000 characters each | first 50, 20,000 each, 100,000 in all |
| A skill's steps | 16,000 characters | 100,000 characters |
| A skill or rule file | 128 KB | 512 KB (room for 100,000 Korean characters; skill shares follow, still 1 MB per skill) |
| A skill loaded with the skill tool | 16,000 characters | up to 22,000 tokens (a tool result: Claude Code cuts one over 25,000) |
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
