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
- **Follow-ups (2026-11-18, branch fix/answer-slips-2):**
  - **EDIT-17.project (product): the work notes came through the answer hold.** The answer began with
    '"공용 회의록" — likely in shared. Find it.' and 'Add under section 1.', each written right before a tool call.
    The hold ([20261117-answer-work-notes.md](20261117-answer-work-notes.md), `chat/narration.ts`) already covers
    such notes but kept both: the first because the person's own words in quote marks made it non-ASCII (Korean), the
    second because "add … under" was no note shape it knew. Now a quoted phrase of at most 40 characters that is in the
    person's message counts as a name, like a quoted file name (while streaming, so does an open quote whose words so
    far are theirs), and an order to itself where to put something ("Add under section 1.", "Append it at the end of the
    notes.") is a work note. A rerun also leaked "Seal lands on (인) correctly. Now post to the room." (CHT-02.room):
    a short bracketed label in another script ("(인)") is a name too, and "Now post …" after a sentence is a note's
    shape. Everything else stays: only before a real call, never the last piece, never content
    copied into the call; "Please add …", a quote that is not the person's words, and Korean text keep the line.
  - **CHT-02 (product): "decide yourself" picks among the options given.** The change is in the ask rule
    (`ASK_USER_RULE` in `chat/prompt.ts`), not in the app map. A first version (fit the person's latest stated intent;
    nothing fits: say so and ask) stopped every old-quote post, but the AI then asked for the price a third time. Owner
    decision (2026-11-18): after "decide yourself" the AI picks among the options already given (on its own question,
    or named by the person or the room; a room message may name an option, never a reason to post), preferring one that
    needs no further approval (the 27,000원 floor, not 26,500원 that needs the CEO's OK), says plainly which and why,
    and posts only through the usual card; it never posts an older version in place of a promised one and never uses
    a price or term nobody named (a price counts only when the person, the room or a file named it, not when only the AI's
    question offered it; a promised version may be made with one that counts). With no option that fits, or a request
    to tidy up or change a file where more than one file still fits (CHT-02.project's "정리"), it asks one more short question, once, never a third about the same choice; still open after
    that, it says in one line what is missing and stops. The room post's card is unchanged; the case expectations say
    the same.
  - **Judge (tests/ai-scenarios only, no rule loosened):** it gets the app's screens (Settings sections from
    `web/src/pages/settingsTabs.ts`, Admin's pages: "Trina AX MCP" is a section's name, Settings › Usage is everyone's
    own usage; "MCP" as a word of its own is still jargon; buttons inside a screen are not listed and not invented for
    that), the install's AI sign-in as the person block gives it (the computer's own: nobody switches to their own
    account here) and where earlier versions and the Restore button are, the model that answered each turn (the engine tells the AI
    its model), the asker's name with the given name ("하나 님" for 최하나), and each turn's own send time in the zone it
    was sent with (`TurnRecord.sentAt`; older results fall back on the case start and say so) instead of the case start.
- **Tests:** `tests/unit/narration-hold.test.ts`, `tests/unit/ai-app-map.test.ts`, `tests/unit/ai-answer-facts.test.ts` (also a real turn's map for a member
  before and after the team lets them pick), `tests/unit/ai-scenarios-prompts.test.ts`.
- **Version impact:** patch (the AI's answers; no screen, API or migration).
