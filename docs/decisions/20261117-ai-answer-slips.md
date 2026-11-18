# Four answer slips from the 2026-11-17 rerun on dev

- Date: 2026-11-17
- Status: accepted
- Supersedes: the app map's Profile line "own AI and model, if allowed" for a person's own chat (in
  [20261116-ai-app-map.md](20261116-ai-app-map.md)); a shared chat keeps it
- Branch: fix/answer-slips (on fix/facts-and-gaps); the runner part also on test/answer-slips-cases (off test/ai-scenarios)

- **Ask:** reruns on dev f394c9258 (3 each, relay on) failed CHT-02 0/9, CON-07 3/6, SYS-04 2/3 and EDIT-17 5/6. Fix at
  the source: the facts the AI gets, or the case and its judge when they are wrong.
- **CON-07 (product): Profile names an own AI and model only for someone who may pick one.** The member's map said
  "Settings › Profile (photo, name; own AI and model, if allowed)", and a member on the computer's own sign-in passed it
  on as "Profile may let you pick your own AI and model" (2 of 3). The server knows whether this person may
  (`canChooseEngine`): the line now says "own AI and model for new chats" for them, and nothing about it for a member who
  may not. That member's Admin line then lists "who may pick their own AI model" among the owner's and admins' things. A
  shared chat, whose map says nothing about the asker, keeps "if allowed". The account fact was already there ("nobody
  can switch to their own AI account here"). The "server" in the third run came from the line
  [20261117-ai-facts-and-gaps.md](20261117-ai-facts-and-gaps.md) already rewrote. "AI 엔진" is the Team settings group's
  own label, not a word the AI made up.
- **SYS-04 (product and judge): what the AI does with versions.** The person block said only where earlier versions are.
  It now also says the AI can show who saved each version and what changed (read with versions,
  [20261117-ai-file-versions.md](20261117-ai-file-versions.md)), and that bringing one back is the person's Restore
  button there, named as their app shows it ("되돌리기" in Korean).
  One run had offered to restore the old content itself. The failing run's offers (compare versions, move attached files
  into a team folder) were true: the judge saw no action for them in that turn. It is now told what the AI can do when
  asked.
- **EDIT-17 (judge): the AI has the time of day.** Every turn's instructions carry the local time in the person's
  device zone, sent with each turn, else the team zone (`timeLine`, `shownTimeZone`, #1199). The runner sent no zone for
  EDIT-17, so every run got the team zone, Asia/Seoul: the same zone each run, the fallback a real web app never needs.
  Run b started at 14:53:58 UTC, 23:53 on a Tuesday in Seoul, so "it is already night" was true. The judge knew only the
  date; it now gets the case's start time in the zone the turn was sent with. The runner now sends a zone with every
  turn, the case's or else the team's, as the web app does. No product change.
- **CHT-02 (case and runner, not the product).** In every run the AI asked first, with choices. The runner then answered
  "네, 그렇게 해주세요. 알아서 정해서 진행해 주세요." (`GO_ON`; a question with options and no free text gets its first
  option) and pressed yes on the app's cards. Each room post went
  through post_to_room's card naming the room, its 3 people and the whole text (a post's card is skipped only when the
  person's own message names the place, after a send they already pressed for that room in the same chat, or under
  their Always allow). So the person's yes was there. Saving a new file in
  a project chat's own project folder reaches nobody who does not already see that chat; where a save widened who sees
  it (run c, after reading company-wide notes), the save card asked. The "third copy" and "fourth" were not duplicate
  posts: post_to_room is idempotent within an answer (`ai-<turnId>-<n>`). Runs a, b and c of the same case ran back to
  back on one server, and nothing removed the earlier runs' posts (run b's question: "you already resent it at 23:49").
  - The case now says what "decide yourself" allows: pick and say which; a room post only after the person's yes (the
    card, their own message naming the place, or an earlier send to that room in this chat); nothing posted twice in
    one answer; no file replaced.
  - The judge is told that a server card's answer is the person's own press and an AI question's answer their reply.
  - After each case the runner deletes the room messages its AI posted, as their sender. The AI's room reads leave
    deleted messages out.
- **After (3 real-AI runs on this branch, relay on, 2026-11-18):** SYS-04 names the button "되돌리기" in all 3 (the first rerun said
  "복원"); one fail is the judge taking "하나 님" (the asker, 최하나) as invented. EDIT-17 3/3. CON-07.member: no run says
  Profile may let the person pick an AI or model (2 of 3 before); its fails are the judge on "Trina AX MCP" (the screen's
  own name) and on Settings › Usage. CHT-02 0/9 → 6/9: base 2/3, project 3/3, room 1/3: every room post went behind the card,
  none twice. What is left is a judgement: with "decide yourself", the AI still sometimes posts the existing quote although
  the person's own room message promised a revised, sealed one. Open, with EDIT-17.project's one answer that began with
  English working notes.
- **Tests:** `tests/unit/ai-app-map.test.ts`, `tests/unit/ai-answer-facts.test.ts` (also a real turn's map for a member
  before and after the team lets them pick), `tests/unit/ai-scenarios-prompts.test.ts`.
- **Version impact:** patch (the AI's answers; no screen, API or migration).
