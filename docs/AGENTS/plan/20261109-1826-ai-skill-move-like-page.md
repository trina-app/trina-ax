# The AI moves a skill like the Skills page does, behind a card that names people

- Date (UTC): 2026-11-09 18:26
- Branch: `fix/ai-skill-move-like-page`
- Status: in progress
- Where: trina-ax core (`server/src/skills/move.ts`, `server/src/skills/text.ts`, `server/src/chat/tools.ts`,
  `shared/src/tools.ts`, `web/src/components/chat/AskCard.tsx`, `web/src/components/skills/MoveSkillDialog.tsx`,
  `web/src/i18n/`). Why: skills and permissions are core features of every team server (see docs/REPOSITORY-RULES.md)
- Version impact: patch. The AI tool takes the moves the Skills page already makes; no API shape, no migration.

## Goal

The owner asked the AI, in a project chat, to move two group skills from the leads group into the project
"견적서 제작". `move_skill` refused: "at <project> 2 more people would get this skill (3 → 3). You can only move a skill
where fewer people get it", and sent the owner to the Skills page. The owner then asked who the two people were and the
AI could not say: the tool gives counts only, and "2 more (3 → 3)" reads as a contradiction (two gain it and two lose
it). The owner found it too restrictive: "왜케 제약이 많아?? … 이유도 모르고?".

The narrowing-only rule came from the review of #248. The owner's approved design was different: the card says who
gains and who loses, and shows the whole SKILL.md when more people would get it; the person decides on a server card
the AI cannot forge. This goes back to that design.

## Scope

In:

- `move_skill` proposes any move the person could make with the Skills page's 옮기기…, with the same checks (write on
  both places, the name free at the target, a SKILL.md folder for a project, no wider skill of the name for a
  project). `AI_MOVES` and the `gained` / `editorsGained` refusals go. Still refused in scheduled runs and not offered
  in rooms, shared chats or sub-agents.
- The card names people: who newly gets the skill, who stops getting it, who newly may change it. Names the asker can
  already see in the app: owners and admins everyone; a member the people of their own groups (each group's team room
  lists them) and themself. The rest are counted ("외 N명"); long lists are cut at five names ("외 N명").
- The card shows the whole SKILL.md when anyone new gets the skill (as the Skills page does), and also when the skill
  leaves a project (it then runs in all the chats of the people who keep it, no longer marked as project content).
- The card's yes stays bound to the hash-bound token (every file, the target, who gets it, who may change it).
- Count wording: "2명이 새로 쓰고 2명은 못 쓰게 돼요 (3명 → 3명)" on the card, in the tool's text and in the Skills
  page's dialog, in the five app languages.
- Every refusal in the tool's result says why and what to do (who can write the place, which name is taken, where), and
  names the people when the reason is about people (a token gone stale because who gets the skill changed). The tool's
  description says this.
- docs/DECISIONS.md "Project skills", docs/PERMISSIONS.md, CHANGELOG.

Out: names in the Skills page dialog (it keeps its counts; the card is where the AI's move is decided), any change to
who may write a level.

## Steps

1. `move.ts`: keep the ids of who gains, loses and newly may change it on the plan; `nameable()` (who the asker may see
   named) and `peopleLine()` (names, then "외 N명"); drop `AI_MOVES`. Clearer `moveNoWrite` / `moveTaken` /
   `moveNotFolder` texts.
2. `text.ts`: `moveConfirm` without counts, `movePeople*` change lines, field labels, `moveEditors`.
3. `tools.ts`: no level or widening refusal; the card with a people detail (fields), the files and, when it widens or
   leaves a project, the whole SKILL.md; results with names; a stale token says what changed; descriptions.
4. `AskCard.tsx`: a yes/no card's field names size to the longest one (the labels are longer than "파일").
5. `MoveSkillDialog.tsx` and the i18n keys: one change line per level.
6. The e2e mock and specs, the unit tests, the docs.

## Risks

- Prompt injection: a planted skill could ask the AI to widen itself. The card is the gate: it is the server's (the AI
  cannot write it), it names who gains and shows the whole text in that case and when a skill leaves a project, and
  its yes is bound to the files and the people shown. Audited as before (`skills.move`, `skills.move_refused`).
- Names: only names the asker can already see (the people directory has every active name; group membership is
  visible to the group's members through its team room; project participants are shown to the project's creator and
  admins, so a member gets counts for people outside their groups).
- No migration, no API change. Five languages for every new text.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; `tests/unit/move-skill.test.ts` (the owner's case: a group
skill into a project where two gain and two lose, named on the card, then moved; a scheduled run; a refusal with its
reason; a stale token), `project-skills`, `b-shared-chats`, the skills suites, the security permission matrix, the
whole `tests/unit`, the web unit tests in Docker, and the e2e `skills` and `project-skills` specs.

## Result

Filled in at the end.
