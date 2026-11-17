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
  [20261117-ai-file-versions.md](20261117-ai-file-versions.md)), and that bringing one back is the person's Restore there.
  One run had offered to restore the old content itself. The failing run's offers (compare versions, move attached files
  into a team folder) were true: the judge saw no action for them in that turn. It is now told what the AI can do when
  asked.
- **EDIT-17 (judge): the AI has the time of day.** Every turn's instructions carry the local time in the team zone
  (`timeLine`). The run started at 23:52 in Seoul, so "it is already night" was true. The judge knew only the date; it now
  gets the case's start time in the team zone. No product change.
- **CHT-02 (case and runner, not the product).** In every run the AI asked first, with choices. The runner then answered
  "네, 그렇게 해주세요. 알아서 정해서 진행해 주세요." (`GO_ON`) and pressed yes on the app's cards. Each room post went
  through post_to_room's card naming the room, its 3 people and the whole text (a post's card is skipped only when the
  person's own message names the place, or under their Always allow). So the person's yes was there. Saving a new file in
  a project chat's own project folder reaches nobody who does not already see that chat; where a save widened who sees
  it (run c, after reading company-wide notes), the save card asked. The "third copy" and "fourth" were not duplicate
  posts: post_to_room is idempotent within an answer (`ai-<turnId>-<n>`). Runs a, b and c of the same case ran back to
  back on one server, and nothing removed the earlier runs' posts (run b's question: "you already resent it at 23:49").
  - The case now says what "decide yourself" allows: pick and say which; a room post only through the card answered
    yes; nothing posted twice in one answer; no file replaced.
  - The judge is told that a server card's answer is the person's own press and an AI question's answer their reply.
  - After each case the runner deletes the room messages its AI posted, as their sender. The AI's room reads leave
    deleted messages out.
- **Tests:** `tests/unit/ai-app-map.test.ts`, `tests/unit/ai-answer-facts.test.ts` (also a real turn's map for a member
  before and after the team lets them pick), `tests/unit/ai-scenarios-prompts.test.ts`.
- **Version impact:** patch (the AI's answers; no screen, API or migration).
