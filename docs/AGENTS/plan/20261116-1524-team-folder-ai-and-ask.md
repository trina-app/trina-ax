# Team folders by asking the AI (admins), and "Ask an admin" for members

- Date (UTC): 2026-11-16 15:24
- Branch: `feat/team-folder-ai-and-ask`
- Status: done
- Where: server/src/admin, server/src/chat, shared, web/src/components/chat. Why: PR 7 of the approved folder-sharing
  design (docs/AGENTS/plan/20261116-1147-folder-sharing.md on `plan/folder-sharing`; see docs/REPOSITORY-RULES.md)
- Version impact: minor, a new AI tool and its card

## Goal

An owner or admin says "give the Sales group view access to Reports" and gets a card with who gains and loses access,
then the change. A member who asks the same gets one button, **Ask an admin**.

## Scope

In: `saveFolderAccess` (one save for the admin dialog's two routes and the tool); `change_folder_access` with the
design's rules (M8, M9, T18, T19); the result as the shared card record (`Step.shared.teamFolder`) and its web card;
Ask an admin through the existing share-fix offer; user docs in six languages; tests.
Out: the design's own ask table and its admin Activity row (the existing Ask an admin covers it, no migration); a Files
menu sheet for members; General access and Limit access by the AI.

## Steps

1. Base: `origin/integrate/folder-sharing` merged with `origin/integrate/ai-sharing` (conflicts resolved by reading
   both sides).
2. Move the two folder-rule route bodies into `server/src/admin/folder-save.ts` without a change of behaviour.
3. `server/src/chat/folder-access-tool.ts`: gates, folder as seen, member → Ask an admin, names, outside-content rule,
   plan from `explainEdit`, the card every time, the plan again on yes, the save, audit, `Step.shared`.
4. Register it (tools, sub-agents, room lists, prompt rule, step label), the web card, i18n in six languages.
5. Tests, docs, real-AI check on a private QA copy.

## Decisions

docs/decisions/20261116-team-folder-ai-and-ask.md

## Result

Built as planned. This plan was written after the base merge and the extraction commit (not as the branch's first
commit). Checks and the real-AI outcome are in the hand-off report.
