# One card for one skill save

- Date: 2026-11-16
- Status: accepted
- Supersedes: none (narrows the archive's "Always allow on every card" for skill saves; builds on
  docs/decisions/20261116-shared-chat-skill-edits.md)
- Branch: fix/skill-save-one-card (QA TC-3813)

- **Ask:** the AI flow check (FL-10 step 1, default and always runs) showed two cards for one new team skill: the skill
  card ("팀 스킬/규칙으로 저장할까요? 팀 전체 AI가 따라요. 팀 스킬 › visit-report.md (새 팀 스킬 "visit-report")") and then
  the wider-audience card ("트리나가 볼 수 있는 사람이 더 적은 내용(프로젝트 › 라마바카페-납품)을 읽은 뒤 팀 스킬 ›
  visit-report.md에 저장하려고 해요. 이곳은 6명이 볼 수 있어요. 저장할까요?"). Cause: write, edit, make_file and edit_hwp
  ask the skill card (chat/turn.ts confirmSkillWrite) and then, separately, the wider-audience check (confirmWidening)
  for the same save. Team rules, group skills and project skills go through the same function, so they had the same
  double card; skill moves and copies (move_skill, skill_files) have no wider-audience check and are unchanged.

## Rule

- **One card.** confirmSkillWrite runs the same wider-audience check first (widenNeed on the call's target and copied
  files, chat/tools.ts widenOf). When it applies, the skill card's question gets one more paragraph with everything the
  wider-audience card said: what was read and where (the same place names, hidden for a place this person cannot see in
  a shared chat), where it is saved and how many people can see it there (en "{ai} read content fewer people can see
  ({sources}) before this save. {n} people can see {target}.", ko "{ai}가 볼 수 있는 사람이 더 적은 내용({sources})을
  읽은 뒤에 저장하려고 해요. {target}에 저장하면 {n}명이 볼 수 있어요."). Nothing narrower read: the card as before.
- **One yes covers both.** Save on that card records the wider-audience yes for that folder and those sources for the
  rest of the answer (as a yes on the wider-audience card does), so confirmWidening asks nothing after it. A no, no
  answer or a scheduled run saves nothing; the refusal the AI reads also says more people can see it there and not to
  save it anywhere else that more people can see.
- **"Always allow skill edits I ask for" covers both.** The card's Always allow is still the `skill_save` kind
  (chat/always-allow.ts; nothing new in Settings). Once it is on, a skill save has no card, and its wider-audience check
  is covered too: the skill save kind is the person's choice for that whole save, which is team-wide (or group- or
  project-wide) by nature and the card said so. The owner's rule: Always allow ends the asking for its scope, no
  guards that make the person's own choice ask again. It does not turn on `save_wider`: a save outside a skills folder
  still asks the wider-audience card (with its own Always allow).
- **Unchanged:** the wider-audience card for every other save (files, make_file outside skills, save_url, room files,
  a PowerPoint's bound approval), a name that is taken (that card saves nothing and does not carry the line), and the
  room-read card: after a room read, the room card already carries the wider-audience question (confirmRoomChange), so
  its yes is recorded first and the skill card then has no extra line.

## Tests

tests/unit/b-skill-save-one-card.test.ts: one card with both texts and one yes; a no and its refusal; Always allow on that
card, then no card at all; a save outside skills/ still gets the wider-audience card; no line when nothing narrower was
read; a project skill.

Version impact: patch (one card fewer, one card line).
