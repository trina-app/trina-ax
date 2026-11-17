# What the AI is told in tool results leads it to plain words: skill titles, project membership, who changes members

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/ai-wording-jargon (real-AI scenario cases SKL-04, SKL-02.member, PRJ-01.outsider, PRJ-03.project,
  ADM-07, ADM-05.member of 2026-11-17)

- **Ask:** answers to team members used ids and internal words, or sent people the wrong way. SKL-04 listed skills as
  `quote-writer`, `meeting-tasks`; SKL-02.member pasted the whole changed skill for the person to copy; PRJ-01.outsider
  never said the person was not in the project; PRJ-03.project sent a member to a private chat to add someone, where
  the tool refuses members too; ADM-07 said "programs or scripts on the server".
- **Causes (checked against each case's record):**
  - SKL-04: the skill list in the instructions gave only the folder name and description
    (`chat/skill-list.ts` buildSkillList). The title people see (metadata `title`, shown on the Skills page) was never
    given to the AI.
  - SKL-02.member: the read-only note after the failed edit (`policy/refusal.ts` readOnlyNote) offered "save it in
    their own folder (users/<id>)", a path and no suggest route, so the AI showed the whole change in the answer.
  - PRJ-01.outsider: the tools answered `not found or no access: 'projects'`, and the instructions forbid guessing
    that permission is the reason (one answer for a missing and a hidden path). The AI could only say it found nothing.
    The first full-catalog run read the project's files because an earlier case (PRJ-03) had added this person to the
    project: a state leak in the runner, not a leak in the product.
  - PRJ-03.project: the person (이소라) is a member but not the project's creator, so she cannot change its members
    anywhere (`mayManageProject`). The shared project chat's rule sent every asker to "Continue in a chat only you
    see" for member changes (`chat/prompt.ts` sharedSection).
  - ADM-07: the "Where you run" section says "server" many times and the plain-words rule did not name it.
- **Rule:**
  - A skill line, a find_skills line, the skill hints, the skill changes of a resumed chat and a loaded skill
    (`<team_skill … title="…">`) carry the title next to the name: `- quote-writer "견적서 작성": …`. The section says to
    call a skill by that title to the user. The skill tool also accepts the title, or the line as written. find_skills
    matches title words as name words.
  - A read-only team skill (skills/…) gets its own next step: only the people who manage team skills change it; in the
    person's own chat the "Suggest as skill" button (in their language) sends the change for review; on request a
    personal copy; "Do not paste the whole changed text for them to copy by hand." Other folders keep their note.
    The same next step follows a team skill the person may not change when the skill tool loads it: in the first
    real-AI run after the fix, one answer loaded the skill, never tried the edit, and pasted the whole file.
  - After `not found or no access` on projects/ or projects/<name>/… that the person cannot read, the file tools add:
    the person is not a member of a project called "<name>", the same answer whether or not one exists (so nothing
    about the path is revealed), and the person who made it or an admin can add them. projects/ itself refused: they are
    in no project. Not for guests, and not for a missing file inside a project they are in.
  - In a shared project chat, when the asker may not change its members, "changing the project's members" leaves the
    "not available here, continue privately" list, and one line says who does: the creator by name while their account
    is active (everyone in that chat is a member, and the members dialog names the creator to them too), or an admin.
  - The plain-words rule names "the server" among the words not to use.
- **Not product bugs (runner or judge):**
  - ADM-05.member ("already Seoul"): the time line of every turn gives the team time zone from the team settings
    (docs/decisions/20261116-time-zone-team-setting.md), so the answer was checked. The judge does not see the
    instructions; the case's expected answer should allow "it is already Seoul" plus "only the owner or an admin
    changes it".
  - ADM-07.member ("nobody can switch it on, admins included"): the app map says this install does not have the
    setting, and admins cannot turn it on in the app. The case's member expectation ("no invented status") contradicts
    its base expectation ("this install does not have it"). If the wording should say who can add it, that is the app
    map's line (`chat/app-map.ts`, owned elsewhere).
- **Prompt size:** personal chats: skills section +6 and −7 words, plain-words rule +1: 0 in all. Shared project chats:
  the repeated "Everyone who sees this chat would see what they bring in or change." goes (−13; the next sentence gives
  the same reason), so a member who may change members has 13 fewer words; one who may not gets the who-changes line
  (+15) instead of four list words: +2. Titles add the skill's own title to its line (data, inside the list's 8,000
  character budget).
- Tests: `tests/unit/ai-wording-jargon.test.ts` (each tool text and instruction line above).
- Version impact: patch (no API, no migration).
