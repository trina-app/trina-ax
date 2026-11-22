# "Folders your AI can see": a card under an answer that could not find a folder, and the demo chip for it

- Date (UTC): 2026-11-22 05:06
- Branch: `feat/demo-permission-scene`
- Status: done
- Where: server/src/chat (a new read-only tool), shared/src (the step record), web/src (the card), scripts/demo/steepling
  (the Home chip). Why: the owner wants the free-roam demo to show the permission scene of the promo film, built as a
  product feature (docs/REPOSITORY-RULES.md: product behaviour lives in the product, the demo only seeds content).
- Version impact: minor. A new AI tool and a new card under answers (a new feature, nothing removed).

## Goal

In the promo film Mina asks "Show me the management folder" and gets "That folder isn't open to you" plus a card of
the folders her AI can see, with a red locked "management" chip. The free-roam demo (demo.trina.app, Steepling) should
show that scene with the real product.

The owner decided (2026-11-22, "근데 실제로는 있는지도 모르긴 해야겠지?"): Mina must not learn that the folder exists.
So the real scene differs from the film on purpose:

- The answer never confirms the folder is there: "I can't find a 'management' folder among the folders open to you. If
  it exists, ask its owner or an admin to share it." The name is only the word she typed.
- The card lists only the folders her AI can see, each with its level (Can edit / Read only). No red chip, no hidden
  name. It reads the same whether the folder is missing or hidden.

## Findings (before this change)

- The product has no such card. Close relatives: the Files "Who can open it" chip and Share dialog (one folder, who
  opens it), Admin › Folder permissions "what <person> can open" (admins only), who_can_open (one item), and the
  instructions' "Writable folders / Read-only folders" lines (server/src/chat/prompt.ts writableFolders), which the AI
  already gets every turn.
- The file tools answer a hidden path and a missing one with the same "Access denied: not found or no access: '…'"
  (policy/authorize.ts; docs/DECISIONS.md "권한 없음과 없는 파일은 같은 문구", tests/security/r3-hidden-vs-missing.test.ts),
  and the instructions tell the AI to say it could not find it in the files the person can open, without guessing that
  it exists (prompt.ts). So today Mina gets a plain "I couldn't find it" line and no list.
- Steepling seeds `shared/Leadership` (ko `shared/대표`, ja `shared/経営`, zh `shared/管理层`, es `shared/Dirección`, id
  `shared/Pimpinan`) as a limited folder only the CEO opens (make.ts `rules`, `checks`: closed for Mina). No chip asks
  for it.

## Scope

In:

1. A read-only tool `my_folders` (no input): the folders the person's AI can see, each with its level, from the same
   rules as the instructions' folder lines (writableFolders: writable and read-only rule folders, `shared`, the person's
   own folder; a folder under one already listed at the same or a wider level is left out). Its step carries the list
   (`Step.folders`) and the web shows it as a compact card under the answer: "Folders your AI can see", one row per
   folder in Files' words, a tag Can edit / Read only. Nothing hidden is named; the tool takes no path, so its answer
   cannot depend on what was asked.
2. The instructions: after "not found or no access" on a folder or file the person asked to open (or when they ask
   which folders they can open), call my_folders once and answer in one sentence that names only the word they used,
   never that it exists, plus who to ask.
3. Where: the person's own chat and a side chat. Not in a shared chat (others would see the list), a guest's turn, a
   scheduled, Slack, confidential, template or restricted run, or a sub-agent (PARENT_ONLY_TOOLS). Other viewers of a
   chat shared later never get the record (ChatStore.viewSteps strips it as it does `shared`).
4. Six languages for the card (web/src/i18n) and the step label (shared/src/step-labels.ts).
5. Steepling: a fourth Home chip in every language, "Show me the management folder" / "경영진 폴더 보여줘" …

Out: naming hidden folders in any form (decided against); the film (it keeps its locked chip); an admin view of
someone else's folders (Admin › Folder permissions has it).

## Steps

1. Plan (this file), first commit.
2. shared: `Step.folders`, the tool's input schema in the tool registry, the step label.
3. server: `chat/my-folders.ts` (the list, the tool, its gates), wiring in chat/tools.ts, subagents, rooms/ai-tools
   lists as needed, the instructions rule, viewSteps stripping.
4. web: `components/chat/MyFoldersCard.tsx`, rendered in Messages.tsx beside the other step cards; i18n keys.
5. Steepling chip in six languages; the README line.
6. Tests, the decision file, changes/ note, screenshots before/after at 1440 and 390, PR to dev.

## Decisions

`docs/decisions/20261122-demo-permission-scene.md`: the card lists only what the person's AI can see; a folder they
cannot open is never named or hinted, and the answer is the same for a missing and a hidden folder. Builds on
docs/DECISIONS.md "권한 없음과 없는 파일은 같은 문구" and the r3 hidden-vs-missing rule.

## Risks

- A leak of a hidden folder: the list is filtered by the person's own access (RuleSet.access) and has no input; tests
  check a hidden folder never appears and the result is byte-identical with and without the hidden folder.
- The prompt pin fixtures (tests/fixtures/engine-prompt-pin) change with a new tool and rule: regenerated.
- No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`; unit: the tool (levels, hidden never listed, missing
vs hidden identical), viewSteps, the card (web unit), the Steepling seed (the chip, the closed folder for Mina).

## Result

Built as planned: `my_folders` (server/src/chat/my-folders.ts), `Step.folders` / `Step.moreFolders`, MyFoldersCard
under the answer, the MY_FOLDERS_RULE instruction, six languages, and the fourth Steepling chip. Differences:

- The list is made in my-folders.ts from the same rules as writableFolders (rule folders, shared/, the own folder,
  RuleSet.access), not by calling it, so a read-only shared/ is listed too; folders not on disk are left out.
- The free-roam Home took at most three chips (shared/src/api/demo.ts, lib/freeRoam.ts SUGGESTIONS_MAX); now four,
  so the chip is added, not swapped for another. On a 390 px phone the four chips wrap to four short rows.
- The prompt pins (tests/fixtures/engine-prompt-pin) were recorded again for the new tool and its rule.
- Screenshots come from the web mock (web/test/e2e/demo-permission-scene.spec.ts), not the live demo.
