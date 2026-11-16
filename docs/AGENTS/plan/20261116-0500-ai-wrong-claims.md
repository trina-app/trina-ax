# The AI says only what its actions showed; a scheduled task may save into a new sub-folder

- Date (UTC): 2026-11-16 05:00
- Branch: `fix/ai-wrong-claims`
- Status: in progress
- Where: trina-ax core (`server/src/chat/prompt.ts`, `server/src/chat/schedule-scope.ts`, `server/src/tools/schedules.ts`,
  `server/src/chat/connect-service.ts`). Why: chat, permissions and scheduled tasks are core (docs/REPOSITORY-RULES.md).
- Version impact: patch. Prompt words, tool result words, and a save folder that may be new (made on the person's yes).

## Goal

The AI scenario check (2026-11-16 first run, root causes #3 and #4) found answers that claim what no action showed: a
team time zone it never read (ADM-05), "I'll show a connect card" after the call failed (CON-02), "I can't delete it"
without trying (SKL-09), "nothing on file" without reading the room that held it (FLOW-03), and a weekly report task
said to save in groups/영업/reports when schedule_create had refused that folder and the task had none (SCH-02).

## Scope

In:
- One short turn rule (and a shorter sub-agent rule): state only what an action of this turn returned; say plainly
  what was not checked.
- connect_service: a refusal without a card always says "No card was shown"; the Drive-not-set-up result names who sets
  it up in plain words.
- schedule_create `save_to`: a sub-folder that does not exist yet is accepted when its nearest existing folder is one
  the person may write and is no blocked folder; the card says the folder will be made; it is made on the yes, then its
  identity is recorded as for an existing folder (lapse, rule fingerprint, readers unchanged).
- The refusal for a group's own folder or a top folder names folders that would work.
- schedule_create's success result always says where runs save.
- Unit tests; a decision file.

Out: the edit dialog and "다시 확인" keep needing an existing folder (they name the task's own folder).

## Steps

1. This plan.
2. schedule-scope.ts: resolveSaveFolder(allowNew), makeSaveFolder, the hint for blocked folders.
3. schedules.ts: card line for a new folder, make on yes, the success text.
4. connect-service.ts results; prompt.ts rules.
5. Tests, decision file, changes fragment, checks, scenario re-run, PR.

## Risks

- Making a folder on the yes: the write check is the same authorize() as any write; the folder is made only after the
  yes and checked again (still missing, same rules) right before.
