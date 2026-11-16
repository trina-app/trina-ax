# A scheduled task may save into a new sub-folder, made on the person's yes

- Date: 2026-11-16
- Status: accepted
- Supersedes: the "What `schedule_create` takes" line of [Scheduled tasks: saving and sending allowed on the card](../DECISIONS.md#scheduled-tasks-saving-and-sending-allowed-on-the-card-featschedule-save-scope-2026-11-10-product-owner) (an *existing* team folder)
- Branch: fix/ai-wrong-claims (AI scenario check 2026-11-16, root cause #4, case SCH-02)

Plan: docs/AGENTS/plan/20261116-0500-ai-wrong-claims.md.

- **Ask:** daniel (group 영업) asked for a weekly Monday report saved in the sales reports folder. `schedule_create`
  refused `save_to: groups/영업` (a group's own folder) and would have refused `groups/영업/reports` (not there yet).
  The AI made the task without a save folder and told him it saved in `groups/영업/reports/…`.
- **Rule:** `save_to` may name a folder that is not there yet when (1) the person may write there (the same
  `authorize()` write check as any new file; a 'none' or read-only rule on the way refuses it), (2) it is no blocked
  folder (`saveFolderBlock`: top, own, hidden, skills, plugin), (3) the nearest folder that exists is neither the team
  root nor `groups/` (a task never makes a top folder or a group folder), and (4) it makes at most 3 folders. Nothing is
  made before the card. The card's line says "(새 폴더: 만들기를 누르면 생겨요)" / "(a new folder, made when you create the
  task)". On the yes (either "create" answer), the folder is made as the person, only if it is still missing under
  the same rule fingerprint and with as many readers as the card showed (else "changed while the card was open",
  nothing created); a file event records it, and its identity (device, inode, birth time), rule fingerprint and readers
  are kept exactly as for an existing folder. Lapses, the edit dialog and **다시 확인** are unchanged (they name the
  task's own folder, which exists).
- **Refusal words:** a group's own or a top folder refused as a save folder now names up to 5 folders inside it the
  person may write (none that is blocked or hidden from them) and says a new one inside it works too.
- **The answer says where runs save:** `schedule_create`'s result names the save folder ("Save folder: …", "(a new
  folder, made now)"), or says that no save folder was set, so runs save in the person's own folder (`users/<id>/`) and
  in a team folder only where that needs no card, and that the AI must not name another place.
- **Why not "refuse with suggestions" only:** making the folder on the yes reuses the write check and the existing
  identity code (an S change); suggestions alone would still leave "save in a reports folder" impossible without a
  manual step in Files.
- Tests: `tests/unit/schedule-save-scope.test.ts` (new folder: card line, nothing made on a no, made on a yes with its
  identity, refused when someone made it while the card was open; top/group folder hints without a hidden folder; new
  top or group folders and more than 3 levels refused, also for an admin; the result without a save folder).
- Version impact: patch.
