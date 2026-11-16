# Find work files: share some of the added files with the team

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: feat/find-files-share-step (the owner; QA TC-3502, TC-3503)

Plan: docs/AGENTS/plan/20261116-0140-find-files-share-step.md. Builds on the archive's "Find work files on this
computer" entries and "A member shares their own files" (#979).

- **Ask:** owner, 2026-11-16: "<product> finds files that are good to share with your team." Until now Find work files
  on this computer (My files, and the invited person's welcome card on Home) added the ticked files to My files › From
  this computer, private, and sharing meant each file's Share dialog.
- **One step, after the add.** When the run is done and at least one file landed, the same dialog asks "Share any of
  these with your team?" over the files that run added (never files that were there already). The parts: the file Share
  dialog's own people-and-groups search ("Add people or groups": a member is offered only their own groups, admins any,
  never a guest, never oneself), the files with a box each and **nothing ticked**, ONE primary button "Share n files"
  (off until a file is ticked and someone added; with files ticked and nobody added one grey line says "Add who should
  see them."), and "Not now". Then the run's result as before (Added n files, Undo, Open, Close) with "Shared 2 files
  with Sales" and the files that could not be shared, in the server's words; a quiet "Share with your team" there goes
  back to the step (the way back from Not now). Nothing unticked is shared; Not now shares nothing.
- **The hint, not a pick.** "Good to share: Form" (ko "공유하기 좋은 양식") on the kinds teams usually keep together:
  form, company intro, brand, policy, training, minutes (a report or a proposal is often one person's or one client's).
  From the AI's own reason for that file in the list before (`rankOwnFiles`, by the path it was added at), else the name
  rules (`nameReason`). No new AI call. Hinted files are listed first; never pre-ticked.
- **No new permission path.** Share is `PUT /api/files/shares` per ticked file, the call the Share dialog makes
  (`web/src/lib/shareFound.ts`): the owner rule (these are the person's own files under `users/<id>/`), the team switch
  "Members can share files they own", at most 50 people and groups, refusals in the server's words, audit and the
  recipients' `file.shared` notices as with the dialog (one per file). The room send budget the server applies to shares
  (20 at once, then one a second) answers 429 with `retryAfter`: the page waits that long and tries the same file again,
  three times at most. Closing the dialog stops; what went stays shared.
- **Skipped** when the person may not share (`GET /api/files/shares` on the first landed file says `canShare: false`,
  the team switch off). Guests never reach Find work files. The owner's setup team-files step is unchanged (its files
  go to the team home, which the folder rules share already).
- **The chat ShareWarning** does not apply: it lists chat answers that used memories, accounts or files; a file share
  widens nothing but that file.
- **Welcome card:** unchanged rules: the row is done once a file landed; every way out of the dialog comes back to the
  card, which reads its rows again.
- **Not added (lean):** a one-press "whole team" (file shares have no everyone subject; adding one is a new permission
  path, left as an open question for the owner), Select all, a search, per-file recipients, a message to the
  recipients, batching the notices into one.
- **Known, not changed here:** at phone width the Files page has no Find work files dialog (a dialog opened on My files
  closes when the window is made that narrow, and its look stops); from the welcome card it stays.
- Tests: web unit `share-found.test.ts`; e2e `find-work-files.spec.ts` (the step, Share, the way back, sharing off) and
  the specs that pass the step with Not now; screenshots `shots-find-files-share.spec.ts` (member, admin, owner; 1440 and
  390; light and dark; en and ko).
- Version impact: **minor** (a new step; no endpoint, no migration).
