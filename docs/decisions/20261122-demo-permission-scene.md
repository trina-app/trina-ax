# A folder you can't open is never named: the answer says "can't find", and the card lists only the folders your AI can see

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (builds on [권한 없음과 없는 파일은 같은 문구](../DECISIONS.md) and the r3 hidden-vs-missing rule,
  tests/security/r3-hidden-vs-missing.test.ts)
- Branch: feat/demo-permission-scene (the owner, 2026-11-22: "근데 실제로는 있는지도 모르긴 해야겠지?"; plan
  [20261122-0506-demo-permission-scene.md](../AGENTS/plan/20261122-0506-demo-permission-scene.md))

- **Ask:** the free-roam demo should show the promo film's permission scene: Mina asks "Show me the management folder",
  the answer says the folder isn't open to her, and a card lists the folders her AI can see, with a red locked
  "management: Not open to you" chip.
- **Rule 1, never named:** a folder or file the person cannot open is never named or hinted, on the card or in the
  answer. The card "Folders your AI can see" lists only folders they can open, each with Can edit or Read only. There is
  no locked chip and no hidden name.
- **Rule 2, can't find, not "not open to you":** the answer never confirms that the folder exists. It says, naming only
  the word the person typed: "I can't find a 'management' folder among the folders open to you. If it exists, ask its
  owner or an admin to share it with you."
- **Rule 3, the same answer for missing and hidden:** the file tools already refuse both with the same "not found or
  no access". The card's tool (`my_folders`) takes no input, so its text and its card cannot depend on what was asked.
  tests/unit/my-folders.test.ts checks that the refusal, the list and the text are identical before and after a hidden
  "management" folder appears, and for a name that was never there.
- **How:** a read-only tool of the main AI, `my_folders` (server/src/chat/my-folders.ts). It lists the rule folders,
  shared/ and the person's own folder that RuleSet.access opens for them (a folder inside one listed at the same or a
  wider level is left out; a folder not on disk is left out). The step keeps the list (`Step.folders`, at most 30, then
  a count), and the web shows it under the answer (MyFoldersCard). The instructions say when to call it: after "not
  found or no access" on something the person asked to open (not a file about to be created), or when they ask which
  folders they can open.
- **Where:** the person's own chat and a side chat. Off in a shared chat or one other people wrote in, a guest's turn,
  a scheduled run, a question from Slack, a confidential chat, a template or restricted run, and for a sub-agent. Only
  the person whose turn it was gets the record (ChatStore.viewSteps strips it for anyone else).
- **The film differs on purpose:** the 97 s promo film keeps its locked "management" chip; the product does not show
  one. The demo's chip (Steepling, all six languages) runs the real behaviour.
- **Left out:** naming hidden folders in any form; an admin's view of another person's folders (Admin › Folder
  permissions has it).
- **Tests:** tests/unit/my-folders.test.ts, tests/unit/b-my-folders.test.ts, web/test/unit/my-folders-card.test.tsx,
  tests/unit/demo-company-seed.test.ts ("the CEO's folder is seeded, closed to Mina, and a Home chip asks for it").
- **Version impact:** minor (a new AI tool and a new card under answers).
