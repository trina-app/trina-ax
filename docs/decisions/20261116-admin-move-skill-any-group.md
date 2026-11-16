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
- **Managing what was moved (owner follow-up):** the owner and admins still see and manage a skill after it is in a
  group they are not in. The Skills page lists such skills in their own section per group, "Group X (you are not in
  it)", with the note that they run only for the group's members (`GET /api/skills?groups=1`, owner and admins only,
  each item `notMember: true`; ignored for everyone else). Their row opens the file and the "..." menu offers Move, so
  they can move it back or elsewhere; edit and delete go through Files and the AI's file tools, which the folder rules
  already allowed. The AI's `move_skill` finds such a skill by name or path, and `find_skills` lists them apart ("do not
  follow"). The skill tool and every run keep using only the groups a person is in (`listSkills` is unchanged), so an
  admin's AI never follows a group's skill it is not in.
- Not changed: `share_skills` to a group, and members' lists in every screen and chat.

## No leak

- The admin's existing visibility: the owner and admins read and write **every** folder outside `projects/<name>/` and
  `users/<id>/` (policy/access.ts "owner-admin"), so they already read groups/<name>/ including its skills, and Admin ›
  People and Folder permissions already name every group's members. The card names who gains the skill only to those
  who may see it (`seesWho`: owner and admins), as before.
- The change does not open any new read: the group's skills are read only to check a name clash, which the admin could
  already do in Files. Members never get the wider target list. Project contents stay members-only; this does not touch
  projects/.
- The audit entry `skills.move` records the group as before.
