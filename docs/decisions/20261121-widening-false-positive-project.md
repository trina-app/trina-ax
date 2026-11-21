# The save card names a connection, room, team Drive or Slack the person can see themselves

- Date: 2026-11-21
- Status: accepted
- Supersedes: none
- Branch: fix/widening-false-positive-project (the owner, 2026-11-22 KST, 0.7.0)

- **Ask:** in a team project "테스트 프로젝트" with exactly two people, after only the owner had used its chat (dev
  environment commands, the ppt-master skill, edits in the project folder), saving `…/svg_output/06_contact.svg` into
  the project folder showed "Save to Projects › … › 06_contact.svg (2 people)? 1 of them can't see where it came from.
  It came from a place someone else opened in this chat." The owner: "there are only two people in the project, how is
  that possible?"
- **Cause:** the card names each narrower source of the chat's read scope (`chat/turn.ts` widenSources) unless the
  person "can't see" it (`TurnExec.seesSource`), which then shows "a place someone else opened in this chat" with no
  count. `seesSource` handled team folders, the person's own folder, names and chat files only; for a connection
  (`integration`), a Drive the team shares (`drive_share`), a room (`room`) and Slack (`slack`) it returned false for
  everyone. So the person's own call to a team connection the other member may not use was labelled as someone else's.
  Reproduced with the fake engine (team connection for one person, two-person project chat, save into the project):
  exactly the owner's card. Not the cause (also reproduced): the dev environment (a project chat's commands run in the
  project folder; what a run may read joins the answer's record, not the read scope, and `chat:work/` does not exist
  there), skills (a team skill is named), the project folder (named) and the person's own folder ("your personal
  folder … (only you)").
- **Rule:** for those four kinds the person sees where it came from when they are among its readers by the read scope's
  own test (`read-scope.ts viewersOf`: may use that connection, are on that team Drive share, see that part of the room,
  read it with their own Slack). The card then names it with its count, as for a folder ("Deck Images (only you)").
  Anyone not among its readers still gets "a place someone else opened in this chat", unnamed.
- **Unchanged:** when the card comes and who is counted. The other member really may not use that connection, so a save
  where they (and anyone who joins the project later) can open it keeps asking: the chat hides that answer from a later
  joiner who may not use it (shared answers' `k` group), a project file would not.
- **Words:** none changed here (branch fix/widening-card-wording owns the card's text).
- **Tests:** `tests/unit/b-widening-own-source-label.test.ts` (the owner's case names the connection and still asks;
  the other member's save after that read still asks with the unnamed label; a team connection both may use asks
  nothing).
- **Version impact:** patch (a card names the right place).
