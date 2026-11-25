# The AI says where to get Hangul files when the HWP plugin is off

- Date (UTC): 2026-11-25 09:04
- Branch: `fix/hwp-plugin-hint`
- Status: done
- Where: server (chat instructions). Why: the AI's instructions are core server code (see docs/REPOSITORY-RULES.md)
- Version impact: patch — one instruction line for the AI while the HWP plugin is off; no API, data or UI change

## Goal

A person asks Trina AX for a Hangul file (.hwp/.hwpx) on a team without the HWP plugin (`app.trina.hwp-preview`).
Today the AI's tools and instructions say nothing about Hangul while the plugin is off
(`PluginManager.hwpWriting`, `chat/prompt.ts makeFileRule`), so it only says it cannot. Admins of teams whose default
language is English never learn the plugin exists. The AI should say plainly that a team admin can install
"HWP Preview" (한글 문서 미리보기) in Admin › Plugins, and offer a Word (.docx) file meanwhile.

## Scope

In: one short line in make_file's rule while Hangul writing is off (`makeFileRule(false, …)`), shown whatever the team
language; the AI uses it only when the person asks for a .hwp/.hwpx file, or writes in Korean and asks which document
format to use. Admins asking get the exact place.
Out: Hangul writing itself stays gated by the plugin (docs/DECISIONS.md "Hangul writing and filling come with the HWP
plugin"); no UI text; no phrase matching in code; resumed sessions started before this change keep their first
instructions (the tool refusal already names the place).

## Steps

1. `HWP_PLUGIN_HINT` in `server/src/chat/hwpx-guide.ts` (the file allowed to hold Korean terms for the AI).
2. `makeFileRule` appends it when `hangul` is false.
3. Tests: `tests/unit/doc-skills.test.ts`, `tests/unit/i-wiring.test.ts` (off: the hint, still no `hwpx` format or
   edit_hwp; on: no hint).
4. Decision file `docs/decisions/20261125-hwp-plugin-hint.md`, `changes/hwp-plugin-hint.md`.

## Decisions

`docs/decisions/20261125-hwp-plugin-hint.md`: changes the "Off, the instructions say nothing about Hangul documents at
all" line of docs/DECISIONS.md "Hangul writing and filling come with the HWP plugin"; the gate itself is unchanged.

## Risks

Prompt size (one sentence, about 60 tokens, only while the plugin is off). No migration, no permissions, no UI text.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun test tests/unit/doc-skills.test.ts tests/unit/i-wiring.test.ts
tests/unit/plugins-hwp-writing.test.ts tests/unit/i18n-languages.test.ts`.

## Result

Built as planned: `HWP_PLUGIN_HINT` in `chat/hwpx-guide.ts`, appended by `makeFileRule` while Hangul writing is
off; tests in doc-skills and i-wiring; decision `docs/decisions/20261125-hwp-plugin-hint.md`. PR: see the branch.
