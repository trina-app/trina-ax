# The AI moves and copies a skill like the Skills page, behind a card that says who gains and loses it

- Date (UTC): 2026-11-09 18:26
- Branch: `fix/ai-skill-move-like-page`
- Status: done
- Where: trina-ax core (`server/src/skills/move.ts`, `server/src/skills/text.ts`, `server/src/skills/guard.ts`,
  `server/src/skills/changes.ts`, `server/src/team-files/service.ts`, `server/src/chat/tools.ts`, `shared/src/tools.ts`,
  `web/src/components/chat/AskCard.tsx`, `web/src/components/skills/MoveSkillDialog.tsx`, `web/src/i18n/`). Why: skills
  and permissions are core features of every team server (see docs/REPOSITORY-RULES.md)
- Version impact: patch. The AI tool takes the moves the Skills page already makes and a copy; optional tool inputs, no
  HTTP API shape, no migration.

## Goal

The owner asked the AI, in a project chat, to move two group skills from the leads group into the project
"견적서 제작". `move_skill` refused: "at <project> 2 more people would get this skill (3 → 3). You can only move a skill
where fewer people get it", and sent the owner to the Skills page. The owner then asked who the two people were and the
AI could not say: the tool gives counts only, and "2 more (3 → 3)" reads as a contradiction (two gain it and two lose
it). The owner found it too restrictive: "왜케 제약이 많아?? … 이유도 모르고?". Then: "if a copy doesn't work either, can
it add a new skill? isn't that the same as copying?": every text told the AI never to copy a skill.

The narrowing-only rule came from the review of #248. The owner's approved design was different: the card says who
gains and who loses, the person decides on a server card the AI cannot forge. This goes back to that design and adds
copies.

## Scope

In:

- `move_skill` proposes any move the person could make with the Skills page's 옮기기…, with the same checks (write on
  both places, the name free at the target, a SKILL.md folder for a project, no wider skill of the name for a project).
  `AI_MOVES` and the `gained` / `editorsGained` refusals go. Still refused in scheduled runs and not offered in rooms,
  shared chats or sub-agents.
- Copies: `move_skill` with `keep: true` (and an optional `name`): one card, read on the original and write on the
  target, every file byte for byte (the bytes the token binds); with `name` only the folder name and SKILL.md's `name:`
  line change. A same-name copy into a project is refused (the person keeps the wider original, so it would never run
  for them): the AI asks for a name or suggests moving. A skill folder with folder rules inside is not copied. Audited
  as `skills.copy`; the file event carries `copiedFrom` (Admin › 팀 스킬 shows it as `from`).
- The card: one change line ("2명이 새로 쓰고 2명은 못 쓰게 돼요 (3명 → 3명)"), who may change it there, names of who
  gains, loses and newly may change it only for the owner, admins and a project's creator for its side (counts for
  everyone else: members do not see group membership or project participants), SKILL.md always (in full when anyone
  new gets it or it would be followed ahead of where it is now, folded otherwise), every file, and a line when a wider
  move hides a project skill of the same name. The hash-bound token stays.
- Count wording on the card, in the tool's text and in the Skills page's dialog, in the five app languages.
- Every refusal in the tool's result says why and what to do (who can write the place, which name is taken, the
  user's groups or projects); a stale card says what changed and to call `move_skill` again. The tool's description and
  the file tools' refusal say move and copy go through `move_skill`, never a README or an empty folder as a stand-in.
- docs/DECISIONS.md "Project skills", docs/PERMISSIONS.md, CHANGELOG.

Out: names in the Skills page dialog (it keeps its counts), a card for the AI's writes into the person's own skills
(follow-up), copies on the Skills page.

## Steps

1. `move.ts`: `planMove` with `copy` / `name` (the same-name check keeps the original for a copy), the ids of who gains,
   loses and newly may change it, the hashed bytes, `shadows`; `seesWho`, `peopleNames`, `changeLine`, `editorsLine`;
   `runCopy`; drop `AI_MOVES`.
2. `team-files/service.ts` `writeSkillCopy` (the verified bytes, placed under a temp name, one file event with
   `copiedFrom`); `changes.ts` maps it to `from`.
3. `text.ts`: the change lines, copy texts, refusals with what to do.
4. `tools.ts`: the card and results; `shared/src/tools.ts` `keep` and `name`; the description; `guard.ts`'s refusal.
5. `AskCard.tsx`: a yes/no card's field names size to the longest one. `MoveSkillDialog.tsx` and the i18n keys.
6. The e2e mock and specs, the unit tests, the docs.

## Risks

- Prompt injection: a planted skill could ask the AI to move or copy itself. The card is the gate: it is the server's
  (the AI cannot write it), it says who gains and loses, shows SKILL.md (in full when it reaches anyone new or would be
  followed ahead of where it is now), and its yes is bound to the files, the name and the people shown. Audited
  (`skills.move`, `skills.copy`, `skills.move_refused`).
- Names: only to who can already see them in the app (Admin; a project's access screen for its creator).
- No migration, no API change. Five languages for every new text.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; `tests/unit/move-skill.test.ts` (the owner's case with
names for the owner, counts for a member, a copy with a new name and its `skills.copy` row, a same-name copy refused,
SKILL.md on the card for a project → team move, a refusal with its reason, stale cards after a file or people change, a
scheduled run), `project-skills`, `c-file-moves`, `b-shared-chats`, the skills suites, the security permission matrix,
the whole `tests/unit`, the web unit tests in Docker, and the e2e skills specs.

## Result

Built as planned after the design review (2026-11-10), which changed the first draft in three ways:

- Copies are `move_skill` with `keep` (one card, the bytes the token binds, binary files too), not the save card for
  each file; the first draft also let a same-name project copy be saved for the people outside the group, which was
  dropped: such a copy never runs for the person, so it is refused and a `name` asked for.
- Names only for the owner, admins and a project's creator for its side (the first draft named the people of the
  asker's own groups to members too; members see no group membership in the app).
- SKILL.md is on every card, folded when nobody new gets it and it is not followed ahead of where it is now.

Also from the review: a wider move over a project skill's name says it hides that one; `skills.copy` audit and
`copiedFrom` → the change's `from`; a copy refuses a folder with rules inside. Left out: a card for the AI's writes into
the person's own skills (follow-up), `copy_files`'s reason when a skill folder is the source (another branch edits that
file).

Checks: typecheck, `check:i18n`, `check:docs`, `docs:api` clean; `tests/unit` 53 failures, the same 53 as on dev; the
permission matrix's 3 failures are dev's (since #267); web unit in Docker and the skills e2e specs pass. PR: https://github.com/trina-app/trina-ax/pull/269.
