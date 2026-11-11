# People are told when older memories are no longer used

- Date (UTC): 2026-11-11 19:03
- Branch: `fix/memories-in-use`
- Status: done
- Where: `server/src/chat/prompt.ts`, `server/src/routes/memories.ts`, `shared/src/api/memories.ts` /
  `entities.ts`, `web/src/pages/Settings.tsx` (Memories), the five locales, a short `docs/DECISIONS.md` section.
  Why: memories are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. A bug fix: the AI already used only some memories; now the person is told which

## Goal

QA TC-213: a member adds 110 short memories in Settings › 메모리. All are accepted and listed with no notice, but the AI
gets only the newest 100 that fit in 4,096 characters (`runtime.ts` `memoriesForPrompt` LIMIT 100, `prompt.ts`
`memoryBlock`), so it cannot recall the oldest and nobody is told. Expected: the app limits how many can be kept and
says so, or Settings / the chat says older ones are no longer used; the AI never forgets silently.

## Decision (simplest option that meets the row)

Keep what the AI gets as it is, and say it in Settings › 메모리:
- The list marks each memory the AI does not get now: "쓰지 않음" on the row, its text dimmed.
- Above the list, when some are not used: "AI는 최근 메모리 N개만 써요. 그보다 오래된 M개는 지금 쓰지 않아요. 계속
  쓰게 하려면 필요 없는 메모리를 지우세요."
- The server works it out with the same code that builds the AI's memory block (one function for both), so the two
  never disagree: `GET /api/memories` items carry `unused: true`, and the page carries `inUse` and `total`.

Out: a hard cap on how many can be kept, raising the limits, and telling it in the chat (the remember tool) as well.

## Steps

1. `prompt.ts`: `memoryLines()` (the lines the block holds) used by `memoryBlock`; `memoriesInUse()` beside
   `memoriesForPrompt` in `runtime.ts`.
2. Contract: `Memory.unused` (optional), the list response with `inUse` and `total` (optional; additive).
3. `routes/memories.ts` list: the flags and counts.
4. Settings › 메모리: the line above the list and the mark on each row (computer layout; the open phone-layout PR #469
   can show the same with the same fields).
5. Tests: server (a person with 110 memories: the newest that fit are in use, the rest `unused`, counts right, and the
   block holds exactly those); web (the line and the marks).
6. Strings in EN/KO/ID/JA/ES; `changes/memories-in-use.md`; a short DECISIONS section.

## Risks

Memories are private (tab 1): only the person's own list changes; nothing reaches admins. No migration. PR #469 (phone
Settings) edits `Memories()` in another place (a phone branch before the computer layout).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new server and web unit tests and the existing
memories tests; a local dev server check with 110 memories.

## Result

Built as planned, with the `docs/DECISIONS.md` section "Memories the AI does not get now are marked". One thing the
row's numbers showed: the 4,096-character block ends before the 100 the turn reads even for short memories (about 85
for "사실 001"; 65 for QA-like "사실 001: 이건 테스트용 사실이에요"), so the cut is worked out from the block, never assumed
to be 100.

Checked on a local dev server: 110 memories added through the API; `GET /api/memories` said `inUse` 65 of `total` 110
and marked from "사실 045" down; Settings › 메모리 showed "AI는 최근 메모리 65개만 써요. 그보다 오래된 45개는 지금 쓰지
않아요('쓰지 않음' 표시). 다시 쓰게 하려면 필요 없는 메모리를 지우세요." above the list and "쓰지 않음" on the 35 such rows
of the first page.
