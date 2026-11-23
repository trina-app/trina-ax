# Every ask has a registry entry

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: docs/ask-registry (the owner, 2026-11-23 KST: "어떤 케이스에 카드가 뜨는지도 좀 전수 조사해서 카테고리별로 나누고 관리가 필요하겠는데?")

- **Ask:** nobody could say how many cards, dialogs and system prompts the product has, which keep asking after
  "Always allow", and which a person can take back in Settings. Card fatigue is the owner's main complaint, and each fix
  so far (docs/decisions/20261116-always-allow-final-rule-a.md, 20261122-always-allow-holds-everywhere.md) found asks
  the one before missed.
- **Rule:** [docs/ASKS.md](../ASKS.md) is the one list of every place the product asks the person for anything: the
  AI's cards (server checks and the AI's own questions), connector, site and command cards, Slack's post buttons, the
  web app's confirm dialogs, and the system prompts the desktop, menu bar and phone apps trigger. A pull request that
  adds an ask adds its entry in the same PR, with:
  - an **Always decision**: the scope of "Always allow" (per person and card kind, connector tool, site, ...) or why
    there is none (a one-off destructive step, an admin action, a sign-in, an operating-system prompt);
  - a **revoke path**: where the person takes the Always back (Settings › 트리나에게 허용한 것 for the AI's cards) or a
    written reason there is none;
  - its **Rule A status**: OK, VIOLATION (it asks again for the person's own action after Always) or OPEN (an owner
    decision is needed). A new VIOLATION is not merged without the owner's OK.
- **Guard:** `tests/unit/ask-registry.test.ts` (a guard test, run by `bun run check:prepush` and CI's quick checks)
  scans the code for the calls every ask goes through (server: `waitForPerson`, `askPerson`, `askAlways`, `withAlways`,
  `askConfirm`, `.confirm(`, TurnRequest literals, `turn.request` publishes, a share dialog's `status: 'confirm'`,
  Slack's post actions; web: `confirmDialog`, `choiceDialog`, `useConfirmStep`, `window.confirm`, the browser's
  permission prompts; apps: native dialogs, permission requests, usage-description strings, Android permissions). It
  fails when a file has more of them than its row in the registry's Code index, when a file with any has no row, and
  when a card kind in the code (`CARD_ALWAYS_KINDS`, `TurnRequest`, `AiAllowance`, `CARD_LATER_TOOLS`) is not in the
  registry's Kinds table. Fewer sites than the row pass, so a branch that removes a card need not touch the table.
- **Why a scan, not markers:** a marker comment at each card would touch every card file while other branches change
  them; the calls are already uniform, so the scan needs no change to card code. A new way of asking that the scan does
  not know must add its pattern to the test.
- **Left out:** fixing the VIOLATION and OPEN items the first inventory found; they are listed in docs/ASKS.md
  "Findings" for their own PRs.
- **Version impact:** none (docs and a test).
