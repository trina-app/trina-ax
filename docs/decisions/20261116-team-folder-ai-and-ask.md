# Admins change a team folder's access by asking the AI; a member gets "Ask an admin"

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/team-folder-ai-and-ask (folder sharing design docs/AGENTS/plan/20261116-1147-folder-sharing.md, PR 7;
  security review M8, M9, threats T18, T19; QA TC-4087, TC-4088)

- **Ask:** "give the Sales group view access to Reports" got a pointer to Admin › Folder permissions. Team folders stay
  the owner's and admins' (a shared drive's managers), but they may now do it by asking, with a card. A member who asks
  gets a next step instead of a dead end.
- **Rule:**
  - `change_folder_access` changes ONE person or group on ONE team folder per call: add (view or edit), change the
    level, or take them off. Never the team root, a folder in someone's own files (`users/`), a project's folder (its
    members are changed on its page, `change_project_members`), `skills/` (skill managers are picked on Admin ›
    Members), "everyone" (General access) or Limit access. A guest only where they have a rule already: a guest is in
    one project at most.
  - The owner and admins only: the role is read again at the call, when the card is answered and in the save.
  - **A card every time.** No "Always allow" kind and no "explicit ask" skip, for adds, changes and removals alike: a
    removal on a team folder takes access from many people at once, unlike stopping one's own file share. The card says
    who gets and loses access and how many people open the folder before and after, from the same preview as Admin ›
    Folder permissions. When the change takes the folder from people while files inside are shared one by one, the
    PERSON picks on the card whether those shares go too; the AI has no input for it.
  - After other people's words came in (a room read, a side chat or quote, a file someone else wrote, a web page,
    `looking_at`), the admin's own message of the turn must name the folder (its path, or its name in quotes: a bare
    "Reports" is an ordinary word) and the person or group in full; else refused with that as the next step.
  - The yes is bound to the plan: on yes everything is planned again and must match the card (the rules hash, the rules
    after, who gains and loses, the folders below), then the save is **the same function as the admin dialog's**
    (`saveFolderAccess`, server/src/admin/folder-save.ts: moved out of the two route handlers without a change of
    behaviour), with the rules hash checked inside its transaction. The audit row says `via: 'ai'` and the turn; one
    more row `folder.ai_access` per call says what was asked and how it ended.
  - The result is the shared card record (`Step.shared` with `teamFolder`), seen only by the person whose turn it was.
  - A member: the folder is resolved as they may see it first. One they cannot open reads exactly like one that does
    not exist (same words, no button). For one they can open nothing is planned or previewed; the step gets the
    existing **Ask an admin** offer (files/share-fixes.ts `forFolder`): their own tap sends the team's owner and admins
    a 1:1 message written by the server.
  - Off in scheduled runs, Slack, confidential chats, template and restricted runs, shared chats, chats others wrote in,
    guests' turns; refused for sub-agents.
- **Why:** an admin's folder change reaches many people and files at once, so it keeps the dialog's every check and a
  card the person reads; a member must never learn from the AI that a folder they cannot open exists (T18), and the
  AI must never save other rules than the card showed or drop file shares on its own (T19).
- **Left out:** the design's own ask table (`folder_share_asks`, Q6) is not built: the AI-sharing work already ships one
  "Ask an admin" (share fix offers, reason `folder`) that sends the admins a server-written 1:1 message, so no migration.
  The design's Activity row for admins ("Hana asked to share …") and the answered notice to the member are therefore the
  1:1 message instead. The Files menu's sheet for a member ("Only admins can share this folder. Ask an admin") is not
  built here: the Share dialog already says "Only admins can share this folder." for a team folder.
- **Tests:** tests/unit/c-folder-access-tool.test.ts (every rule above, the M8 list: project_members Always allow on →
  the card still shows; a hidden folder answers like a missing one; a file someone else wrote plus a room read →
  refused unless named), web/test/unit/team-folder-card.test.tsx.
- **Version impact:** minor (a new AI tool and card).
