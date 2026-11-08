# Slack "Post to channel" checks what the answer used

- Date (UTC): 2026-11-08 09:29
- Branch: `fix/slack-post-check`
- Status: done
- Where: trina-ax core (`server/src/integrations/slack/`, a small export in `server/src/chat/answer-share.ts`). Why:
  the Slack connector and the provenance check are core (see docs/REPOSITORY-RULES.md).
- Version impact: minor. A visible change in Slack (a notice before posting); no API or database change.

## Goal

A Slack question runs as the asker's normal turn, with their full reach (their groups' folders, their own folder,
memories, personal connections). In a channel the answer goes to the asker first, with *Post to channel*, and that
button posts at once: it never looks at what the answer read. An HR member asking in #general for a summary of the
salary review puts `groups/hr/` content in front of the whole channel with one click. The app's 대화방에 보내기 and the
room's @트리나 both check this first.

## Scope

In:
- *Post to channel* first checks what the answer used, with the classifier 대화방에 보내기 uses
  (`chat/answer-share.ts` `provenanceChecker` over the answer's branch use, plus `memoriesInPlay`), against the whole
  team (every active member but the asker): Slack channel members cannot be mapped to team members.
- Everything team-wide: posted at once, as today.
- Otherwise the ephemeral answer is replaced by a short notice naming the places as the asker may see them (folders,
  a connection or Drive by name, "your folder", "your memories", a room), never contents, with *Post anyway* and
  *Cancel*. Post anyway goes through every existing check again (the asker, the link, Slack Connect asked again, the
  once-only claim) and carries a keyed hash of what the notice said; a bare or changed value shows the notice again.
  Cancel puts the answer back, to the asker only.
- Team connections and shared Drives always count as not team-wide (the room AI's rule; their content is outside).
- Five languages for the new Slack texts; docs/SLACK.md and a DECISIONS entry; tests.

- After the review: a Slack thread's chat records the names its listings and globs showed (as a room session does);
  a team of one still counts the asker's own material; a confidential conversation or hidden room answers are never
  posted.

Out: DMs (unchanged), any change to the app's own share flows.

## Steps

1. Export what Slack needs from `answer-share.ts` (the branch use, the checker's place naming).
2. `integrations/slack/post-check.ts`: the team-wide check and the notice's words.
3. `service.ts` `action()`: the check before the claim; Post anyway and Cancel actions.
4. Texts in `text.ts` (ko, en, id, ja, es).
5. Tests in `tests/unit/c-slack.test.ts`; docs.

## Risks

Security: the notice must name only places the asker may look at and never contents; a replayed or forged *Post
anyway* must not skip the notice; the Slack Connect re-check must still apply. No migration. No web change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every `tests/unit/c-slack*.test.ts`,
`tests/unit/b-answer-share.test.ts`, `tests/unit/b-share-existing-chat.test.ts`, `tests/unit/b-rooms-ai*.test.ts`.

## Result

Built as planned in `integrations/slack/post-check.ts` and `service.ts` `action()`, with `branchUse` and the checker's
`placeOf` exported from `chat/answer-share.ts`. The independent security review found that a listing or a glob of a
group folder posted its file names at once (a personal chat's scope recorded only contents), so a Slack thread's chat
now records those names as a room session does (`chat/turn.ts` `noteReads`). Also from the review: a team of one still
counts the asker's own material; a confidential conversation or hidden room answers are never posted (as in
대화방에 보내기), with the answer kept and no button. Tests: 11 new cases in `tests/unit/c-slack.test.ts`. PR: see the
pull request for `fix/slack-post-check`.
