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
  made before the card. The nearest folder that exists is kept by its identity (device, inode, birth time, as for a
  save folder); a disk that keeps no folder creation time refuses it before the card, as it refuses an existing folder.
  The card's line says so inside its bracket: "새 파일 저장: groups/영업/reports (새 폴더, 만들기를 누르면 생겨요. 지금
  N명이 볼 수 있어요)". On the yes (either "create" answer) the folder is made as the person by the Files screen's own
  folder maker (`TeamFiles.ensureFolder`: the write check, composed names, each level checked), only when it is still
  missing, the nearest existing folder is the same one on disk at the same depth, the rule fingerprint is unchanged and
  every missing level was made by this call. Else "changed while the card was open", nothing is created and the levels
  made are taken away again; also when the task cannot be stored. Each level made is recorded (file history, Files
  screen) once the task is stored. Its identity, rule fingerprint and readers are then kept exactly as for an existing
  folder. As for an existing folder, the reader count is not compared on the yes: the rule fingerprint decides (Q1 a,
  people joining or leaving a group change nothing). Lapses, the edit dialog and **다시 확인** are unchanged (they name
  the task's own folder, which exists).
- **Refusal words:** a group's own or a top folder refused as a save folder now names up to 5 folders inside it the
  person may write (none that is blocked or hidden from them) and says a new one inside it works too.
- **The answer says where runs save:** `schedule_create`'s result names the save folder ("Save folder: …", "(a new
  folder, made now)"), or says that no save folder was set, so runs save in the person's own folder and
  in a team folder only where that needs no card, and that the AI must not name another place.
- **Why not "refuse with suggestions" only:** making the folder on the yes reuses the write check and the existing
  identity code (an S change); suggestions alone would still leave "save in a reports folder" impossible without a
  manual step in Files.
- Tests: `tests/unit/schedule-save-scope.test.ts`: the card line; nothing made on a no; made on a yes with its identity,
  every level recorded once; refused (nothing made) when, while the card was open, the folder was made by someone else,
  a rule was added on the way, the folder on the way was renamed or replaced by a link; taken away when the task cannot
  be stored; refused before the card on a disk without creation times, in skills/, in a plugin's folder, as a new
  project, top or group folder, deeper than 3 levels; offered inside a project the person may write; hints without a
  hidden folder; the result without a save folder.
- Version impact: patch.
