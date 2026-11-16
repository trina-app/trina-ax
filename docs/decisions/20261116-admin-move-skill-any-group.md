# Admins move a skill into any group

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (widens "a skill goes only into a group the person is in" of the archive's "Group skills" and "Project skills", for the owner and admins)
- Branch: fix/admin-move-skill-any-group (the owner: "허용해. 관리자잖아"; QA TC-3753, AI scenario SKL-08)

- **Ask:** in the first AI scenario run, an admin asked to move the team skill 견적서 작성 into the 영업 group, which the
  admin is not a member of. The move was refused ("not one of the user's groups") and the AI told the admin to add
  themselves to the group first. The owner decided that admins and the owner may do this.

## Rule

- The **owner and admins** may move or copy a skill into **any group that has a folder** (groups/<name>), on the Skills
  page (Move dialog) and with the AI's `move_skill`. **Members keep today's rule**: only into groups they are in.
- Everything else of a move is unchanged: write on both places (owner and admins write every folder outside the
  members-only project zone), no skill of that name at the target (checked against the group's own skills even when the
  admin is not a member), the card or dialog says who gains and loses it, the yes is bound to the files and the people.
- Code: `movableGroupSkillRoots` (chat/skills.ts) is used by `levelsOf` (skills/move.ts) and, for the name check, by
  `listGroupSkills(..., { anyGroup: true })`. Both paths (UI and AI) go through `levelsOf`. A hand-made request for a
  group a member is not in still gets 404.
- Not changed: `share_skills` to a group (a proposal reviewed by that group's members), the skill lists and what the
  AI runs: an admin who is not in a group does not get that group's skills in their own list or chats, before or after
  the move. A skill moved into such a group disappears from the admin's own skill list (they can still open it in
  Files).

## No leak

- The admin's existing visibility: the owner and admins read and write **every** folder outside `projects/<name>/` and
  `users/<id>/` (policy/access.ts "owner-admin"), so they already read groups/<name>/ including its skills, and Admin ›
  People and Folder permissions already name every group's members. The card names who gains the skill only to those
  who may see it (`seesWho`: owner and admins), as before.
- The change does not open any new read: the group's skills are read only to check a name clash, which the admin could
  already do in Files. Members never get the wider target list. Project contents stay members-only; this does not touch
  projects/.
- The audit entry `skills.move` records the group as before.
