# Files: "Everyone on the team" and one notice for several files

- Date (UTC): 2026-11-16 02:55
- Branch: `feat/file-share-everyone`
- Status: done
- Where: trina-ax (Team AX core: server/src/files/shares.ts, notifications, web Share dialog and Find work files). Why:
  file sharing and notices are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor, a recipient, two endpoints, a page, a push code, an additive migration

## Goal

Owner decisions 2026-11-16 (3-1 B, 3-2 A; QA TC-3509, TC-3510): a whole-team recipient for file shares, and one notice
(one push) when one press shares several files.

## Scope

In: the reserved group id `*` as "Everyone on the team" (grant, access check, rows, audit, counts); the batch
endpoint and the press's list endpoint and page; one notice per person per press; push for shares by name; the
option first in both pickers with the line before the press; docs, decision, changes.

Out: the iPhone extension's title, a push setting of its own, the AI tool, "Shared with me".

## Steps

1. Migration 407 (batches, items, notices.named, push deliveries).
2. shares.ts: `REACHES`, `checkSubjects`, `shareMany`, `batchFiles`; notices; push source and path.
3. Web: `ShareEveryone.tsx`, the two pickers, the batch call, the notice text and link, `/f/batch/:id`; mock.
4. Tests (server under Bun 1.3.12, web unit, targeted e2e), screenshots at 1440 and 390, light and dark, per role.

## Risks

Security review: the reserved id must never reach a real group's checks (projects, chats refuse it); the batch list
answers only someone the press told; one token per press. Migration numbers: 407 was free on dev and open branches.

## Result

Done as planned; decision docs/decisions/20261116-file-share-everyone.md.
