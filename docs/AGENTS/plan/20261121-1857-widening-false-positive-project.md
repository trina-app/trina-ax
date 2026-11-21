# The save card no longer says "someone else opened" a place the asker opened themselves

- Date (UTC): 2026-11-21 18:57
- Branch: `fix/widening-false-positive-project`
- Status: done
- Where: server/src/chat/turn.ts (the widening card's source labels). Why: the label rule lives with the card
  (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a card names the right place; what asks and what is saved is unchanged

## Goal

The owner (2026-11-22 KST, 0.7.0) saw, in a team project chat with exactly two people, after their own work there:
"Save to Projects › … › 06_contact.svg (2 people)? 1 of them can't see where it came from. It came from a place someone
else opened in this chat." Only they had used the chat, so "someone else opened" was false.

Found from the code and reproduced with the fake engine: the asker's own call to a team connection that the other
member may not use (its "who can use" rule leaves them out) puts `{type:'integration'}` in the chat's read scope. The
widening check counts it correctly (the other member really may not use that connection: a real protection, and the
answer is already hidden from later joiners who may not). But the card's label for a source the asker "can't see"
comes from `TurnExec.seesSource`, which has no case for `integration`, `drive_share`, `room` or `slack` and returns
false for them for everyone, so the asker's own connection (or room, team Drive, Slack read) is always called "a place
someone else opened in this chat", without its name or count.

Ruled out as the cause (repro): the dev environment in a project chat (its commands run in the project folder; what a
run may read joins the answer's record, not the read scope), skills (a team skill is named), the project folder (named),
the person's own folder ("your personal folder … (only you)").

## Scope

In: `seesSource` for `integration`, `drive_share`, `room` and `slack`: the person sees where it came from when they are
among that source's readers by the read scope's own test (`viewersOf`); the label then names it with its count, as for
a folder. Nothing about when the card comes, who is counted, or what is saved changes.
Out: the card's words (branch fix/widening-card-wording owns them); whether a save after the shared connection card
should ask at all (it should: the answer is hidden from later joiners, a project file would not be).

## Steps

1. Plan (this file).
2. `seesSource`: the four types by `viewersOf(db, rules, s, [me], me.id)`.
3. Unit test: the owner's case end to end (team connection only the asker may use, 2-person project chat, save into the
   project folder): the card still comes, says "1 of them", and names the connection, not "someone else opened";
   another member's connection read is still "someone else opened".
4. changes/ note, decision file, tests/security, typecheck, check:prepush.

## Decisions

docs/decisions/20261121-widening-false-positive-project.md.

## Risks

A label shows a connection's or room's name only to someone among its readers (who may use that connection, sees that
part of the room), never to anyone else. No migration.

## Tests

`bun run typecheck`, the new unit test, the widening and shared-chat connection tests, `tests/security`,
`bun run check:prepush`.

## Result

Built as planned: `seesSource` takes `viewersOf` for the four kinds; the owner's card reproduced exactly before the fix
("It came from a place someone else opened in this chat.") and now reads "It came from Deck Images (only you)." with the
same "(2 people)? 1 of them can't see where it came from". `tests/unit/c-reader-counters.test.ts` lists the new
`viewersOf` call. The other member's save after that read keeps the unnamed label. PR: see the branch's pull request.
