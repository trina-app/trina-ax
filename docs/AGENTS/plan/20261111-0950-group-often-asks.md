# Home: what people in my group often ask, in place of the skills card and "My frequent questions"

- Date (UTC): 2026-11-11 09:50
- Branch: `feat/group-often-asks`
- Status: in progress (revised after an independent review, see "Review"; the owner's decisions of 2026-11-11 below)
- Where: this repo (Team AX core): `server/src/chat/`, `server/src/admin/settings.ts`, `shared/src/api`, `web/src`
  (Home, TeamPrepared, Admin › Team settings, i18n), one migration in B's range. Why: chat, the AI and Home are core
  (docs/REPOSITORY-RULES.md).
- Version impact: minor. A new Home list, a new team setting (on by default), new tables, two Home sections removed.

## Goal

The product owner looked at the new chat screen on 2026-11-11. Under the box, the framed card "Frequently used skills"
(`components/PopularSkills.tsx`) shows skill slugs ("remotion-video"), AI-facing descriptions ("Use when someone asks
for…") and "3 uses · 2 people". It looks bad. The owner asked:

- "Just show simply what prompts the team types, and More shows more. Can an admin turn it off?"
- "Especially what people in the same group type!"

What changes for people: under the box there is no card any more. A small heading and three one-line questions that
people in my group often ask. **More** shows up to 10. A click puts the question in the box; it never sends. Nobody can
see who asked or how many times. A team or group with too little data shows nothing. An admin turns it off for the
whole team.

## What exists today (read first)

- **My frequent questions** (`components/FrequentQuestions.tsx`, `GET /api/questions/frequent`,
  `server/src/chat/frequent-questions.ts`): the person's **own** questions from the active branch of their chats in the
  last 30 days, **exact text** after trimming and collapsing spaces (no grouping of similar questions), counted 2+
  times, top 10, with "N times". It leaves out room AI sessions (`room_id`), the server's own chats
  (`chat/internal-chats.ts`), scheduled runs and messages over 2,000 characters. It does not leave out project chats,
  side chats or Slack questions (fine there: they are the person's own). No AI, nothing stored.
- **Frequently used skills** (`components/PopularSkills.tsx`, `GET /api/skills/popular`): only Home uses it (the Skills
  page no longer does). Hidden while "Ready in your team" shows skill rows.
- **Ready in your team** (`components/onboarding/TeamPrepared.tsx`, docs/DECISIONS.md "W6.3"): the newcomer block.
  Team skill rows until the person ran a team skill, "however many chats they have"; the team files row and one ready
  question while they have no chats; for an owner or admin with nothing prepared, "Add skills · Add team files".
- **AI work outside a person's chat** does not exist: every AI call is a chat turn. The welcome steps' file picks
  (`onboarding/file-rank.ts`) and the skill share judgement (`skills/share-judge.ts`) run as a turn of a person in a
  chat the server marks as its own (no tools, the material inside `<material>`, a JSON answer read defensively, the
  chat deleted with its engine folders once read). Such chats **still open by their address and still send message
  events** to their person (`internal-chats.ts` header; `runtime.ts` 431, 470, 559–562; `turn.ts` stream and notice
  events), and file-rank's AI check lets a turn run on the hosting service's trial credit. This plan reuses the
  pattern but closes both (section 4).
- **Groups** (`groups`, `group_members`): admin groups, "부서" in Korean, managed in Admin and through the connector.
  `group_members` has no join time. A person can be in several groups or none.
- **Projects**: since PR #355 (open on 2026-11-11, owner option B) a team project's contents are for its members only.
- **Turn origins** (`turns.client_kind`): `web`, `desktop`, `mobile` for what a person sent in the app; `schedule`,
  `slack`, and `null` for turns the server makes (skill merge requests, drafts, judgements, file picks).

## Design

### 1. Which questions count

Only what a person typed in the app, in their own AI chat, **while the switch was on**. Everything else is never read,
so it never reaches the AI:

- **Since the switch was last turned on** (on by default: since this build first started). Nothing people wrote before
  the update counts: they were not told. The changes note tells them, and the list shows up after a week or two of use.
- The person's own AI chat: `room_id IS NULL`, `side_room_id IS NULL`, **`project_id IS NULL`**, not one of the
  server's own chats, not a Slack thread (`slack_threads`), not a confidential chat (`safe-ops/confidential.ts`), not
  deleted, the author an active account. So:
  - **Project chats never count** (own or shared). With #355 a project question must not reach non-members; without
    #355 the same rule is simply safer.
  - **Room questions never count**: room @Trina sessions (`room_id`) and side chats (`side_room_id`: they quote other
    people's room messages).
  - **Slack questions never count** (Slack people come in as `@name`).
- A message the person sent from the app: role `user`, author = chat owner, its turn's `client_kind` is `web`,
  `desktop` or `mobile` (an allow-list: scheduled runs, Slack and every request the server writes itself, such as skill
  merges, are left out, and any new server-made turn is left out by default), not `auto_sent`, on the chat's active
  branch, sent in the last **30 days**.
- Not a skill run: text starting with `/` is skipped (skills have the `+` menu and the Skills page; a skill form's text
  is often private).
- Not a prompt the app wrote: one list of the app's prompt templates (Home's ready questions and files question with
  its folder placeholder, the humanizer start, the side chat's quick questions, in all five languages), matched as
  templates, not exact text; and not a sentence on the current lists (a clicked suggestion does not keep itself there).
- What is used: the **first line** only, with Markdown quote lines (`> …`) and thread references removed, at most
  **200 characters** (a longer first line is skipped: pasted text, not a question). Attachments never.
- Before the AI sees it, the server masks: links → `(link)`, emails → `(email)`, digit runs → `(number)`, secrets
  (`maskSecrets`), `@` mentions → `(person)`, the names of the team's people (full name, each part, the surname with
  an honorific such as "김 과장" or "田中さん") → `(person)`, project names → `(project)`, private room and group chat
  names → `(room)`. **Group names and public room names stay**: they are not secret, and they are often what a group's
  questions are about.
- One entry per person per distinct question; at most 40 per person (the newest) and 600 in all (when more, each
  person's newest first, so no one person fills the material). The AI sees the entries in random order with
  meaningless ids (`q1`…), **never who wrote them**. `<material>`, `</instructions>` and every other tag the
  instructions use are broken inside entries.

### 2. One AI run a day, then rules the server checks itself

- **The run:** one restricted turn a day for the whole team. The AI groups entries that ask for the same thing and
  writes one short sentence per group in the team's language, **using words the entries share and plain task words
  only**: no names of people, companies or customers, no numbers, dates, file or folder names, nothing about one
  person's life (health, pay, leaving, complaints about someone, legal or family matters). It answers
  `{"items":[{"text":"…","ids":["q3","q17","q40"]}]}`. The ids are only candidates: the server decides who counts.
- **Words.** The server reads a sentence as words. In Korean, Japanese and Chinese, a word is checked by its
  two-character pieces; in other languages by the word and its start (4+ letters: "Acme's" and "Acme" are one word). A
  fixed list per language holds **generic words**: function words, particles and endings, and common task words
  (summarize, write, translate, draft, check, explain, compare, email, report, meeting, schedule; 요약, 작성, 정리,
  번역, 초안, 확인, 회의, 일정, 해 줘…).
- **The checks**, for each item and each audience (a group, or the whole team). The sentence stays for that audience
  only if all hold; otherwise it is dropped there, never repaired:
  1. **Generic shape:** one line, 4–80 characters, no digit of any script, no link, email, `@`, `#`, path or
     file-like word (`.pdf`, `/`, `\`), no Markdown or brackets, none of the masked names (people, projects, private
     rooms).
  2. **Every word is explained.** Each word of the sentence is on the generic list, or (after a known ending from the
     list) each of its pieces is used by **3 or more people of the audience** (rule 4). A word nobody typed, or an
     ending not on the list, drops the sentence. So a transliteration ("Acme" → "애크미"), a translation ("현대" →
     "Hyundai"), a longer form ("현대차" → "현대자동차") or a capitalised name can never be the AI's "own word": the
     check fails closed.
  3. **Backed by 3 or more people.** A person counts for the item only when one of their entries among the item's
     ids shares a word with the sentence that is **not** on the generic list. The item needs 3 or more such people of
     the audience (by rule 4). Small common words ("how", "에서") back nobody, so the AI cannot pad an item with
     unrelated ids.
  4. **Not all from one circle.** The people behind a word or an item are not all inside one circle that leaves out
     someone of the audience. Circles: groups; team projects (the people who read `projects/<name>` by a rule, not by
     their role); private rooms and group chats of 3 or more. (Three people all in Sales make no item for the whole
     team; three who are all in project P or in one private room make none for their whole group.) People who share a
     secret outside any group, project or room are not covered; DECISIONS says so.
- **Audiences need enough people.** The whole team and each group count only when **5 or more of their members
  asked something** in the window (one floor for every audience; the owner chose 5 over the review's 10 on
  2026-11-11). With fewer, a list would tell people who asked: in a 3-person team every item means all three did.
  Trial teams of about 3 people see nothing, by design.
- **Group membership counts from the day someone joined.** A new `group_member_since` table, filled by a trigger on
  `group_members` (so Admin, invite links and the connector are all covered; rows that exist when this build starts
  count from that day), records when each person joined. A question counts for a group only if it was sent while
  the person was in it and they still are.
- **Lists change slowly.** Per audience: the items that passed, at most 10, in the order of how many people asked
  (ties by text, never by time). A list with fewer than 3 items is not shown. An item that stops passing stays for
  **3 more days**, then goes, so comparing lists the day after a membership change or a deleted chat shows nothing;
  the same 3 days are the longest a deleted chat or a person who left can stay behind. A list that no run renewed for
  3 days is deleted. Counts, ids and the material are never stored.

### 3. Who sees which list

The server picks one list for the caller (`GET /api/questions/often-asked`):

- In one group with a list: that list. Heading "People in {group} often ask".
- In several groups with lists: one list, taking turns between them in rank order, the same sentence once, at most 10.
  Heading "People in your groups often ask".
- No group, or none of my groups has a list: the team list. Heading "Your team often asks". By rule 4 it never holds
  one group's, one project's or one private room's topic.
- None: nothing at all (no heading, no empty state).
- Only current members see a group's list (read at request time). Owners and admins see only the list they would see
  as a member; there is no admin view of all lists and no view of the questions.
- Not on a project's new chat (`/?project=`), the demo server's screen, or while no AI answers the person (as Home's
  suggestions today).

### 4. Running and cost

- **When:** once a day after 05:00 in the team's time zone (after the default update window), at the next chance if
  the server was off. At most one run at a time and one successful run per 20 hours. No AI call while the switch is
  off, or while no audience has 5 people who asked something.
- **On whose AI:** the owner's (the oldest active owner), as the welcome steps' picks run on the person who asked:
  their engine, their AI connection, their budget, their usage line; the engine's faster model when the team's model
  list has one. **Only a connection of the team's own that works now:** never the hosting service's trial credit,
  never "answer with the other AI". No such connection, the owner's budget used up, or the owner's queue full (3 places
  per person): no run that day; the lists stay (up to 3 days).
- **Limits:** one turn, 10 minutes then stopped (nobody waits for it); material at most 600 entries and about 60,000
  characters (Korean is about 40–60k input tokens: a few cents a day on an API key, one turn a day on a subscription);
  at most 30 items read from the answer.
- **No tools, by a list.** The run's turn gets the same refusals as the file picks, named in one place: every file,
  room, connector, browser, web, memory, skill, sub-agent and ask tool is refused, and it gets no team rules, skills,
  memories, project or attachments, only its own instructions (`turn.ts` system prompt, `tools.ts` both tool paths).
  A prompt-injected entry cannot make it read or write anything.
- **Silent.** The run's turn has one flag, checked where the runtime publishes: **no event of any kind** (queue
  position, created, streamed text, done, stopped, notices) reaches anyone, the owner included; its answer holds
  sentences before the checks. `chatFor` (`chat/shared.ts`) refuses its chat by address for everyone, so every chat
  route does. On failure the log gets the error kind only, never the engine's output.
- **Gone after reading.** The run's chat is marked by a new table (`often_asked_runs`, in `internal-chats.ts` MARKS):
  never listed; its material lives only while it runs; it is deleted with its engine folders once read, on failure,
  and by a sweep after a restart (`forgetPurgedChats`, as `file-rank.ts`). The turn row stays for the owner's usage,
  without text. Not run during the nightly backup.

### 5. Home

- **Removed from Home:** "Frequently used skills" (`PopularSkills`) and "My frequent questions"
  (`FrequentQuestions`). One list under the box instead. Skills stay in the `+` menu and on the Skills page.
- **One block at a time under the box, in one slot:** "Ready in your team" (the newcomer block) or the new list, never
  both. "Ready in your team" keeps its files row and ready question for a person with no chats, and its skill rows
  **until the person ran a team skill or has 5 chats** (today: until they ran one, however many chats). Then the list
  takes the slot. Without this, a member who never runs a team skill would never see what the group asks.
- **The list** (`components/OftenAsked.tsx`): no frame, a small muted heading, 3 rows, each one line with an ellipsis
  (the full sentence in its `title`), a button that calls Home's `choose` (fills, focuses, never sends). Under them a
  quiet **More** that opens the rest in place (up to 10) and then reads **Less**. No counts, no names, no icons.
- **Phones (390):** no frame; 44px rows in line with Home's other rows; the slot where "Ready in your team" is today
  (after the one-thing row and the three recent chats).
- **Words, English first** (`web/src/i18n/en.ts`, then ko, id, ja, es):
  - `home.oftenAsked.team` "Your team often asks" (ko "우리 팀에서 자주 묻는 질문")
  - `home.oftenAsked.group` "People in {group} often ask" (ko "{group}에서 자주 묻는 질문")
  - `home.oftenAsked.groups` "People in your groups often ask" (ko "내 부서에서 자주 묻는 질문")
  - `home.oftenAsked.more` "More" (ko "더 보기"), `home.oftenAsked.less` "Less" (ko "접기")
  - The `home.frequent*` and Home-only `skills.popular*` keys go.

### 6. The admin switch

- **Admin › Team settings › Members and AI**, a switch row like "Members can make team projects". Team setting
  `oftenAsked` (boolean, default **on**; `TeamSettings`, `DEFAULT_SETTINGS`), saved with the page's Save bar.
- Title: **"Show what the team often asks"** (ko "팀이 자주 묻는 질문 보여 주기").
- Description (short, like its neighbours): "Under the box on a new chat, people see questions several people in
  their group or team asked, reworded without names or numbers. Nobody sees who asked. Uses the owner's AI once a
  day." (ko "새 채팅 입력창 아래에, 같은 부서나 팀에서 여러 명이 물은 질문을 이름·숫자 없이 다듬어 보여 줘요. 누가 물었는지는
  아무도 몰라요. 하루 한 번 팀장의 AI를 써요.")
- Off: the stored lists are deleted at once, the endpoint answers an empty list, no run starts, and questions sent
  while it is off never count. On again: counting starts from that moment.
- **No personal switch.** Nothing a person typed is ever shown: only a sentence made of words 3+ people used. A switch
  would add a setting to every person's screen and suggest that their words are shown. (Owner's call; see below.)

### Compared with what people know

ChatGPT, Gemini and Claude.ai show generic starters or category chips under the box, the same for everyone; Notion AI
and Slack show a short "suggested" list with a small heading. None mines co-workers' prompts; Microsoft 365 Copilot
shares team prompts only when someone saves and shares one. So the look follows Notion and Slack (heading + lines, no
card), and the privacy rules are stricter than a suggestion list usually needs. Three-second check: "Your team often
asks" with three plain questions under the box reads at once; a tap fills the box as a ChatGPT starter does, and
nothing is sent.

## Scope

In: the material, the daily run, the checks, the stored lists, the endpoint, the switch, Home's list, the removal of
the two Home sections, the "5 chats" end of the newcomer skill rows, five languages, docs.

Out: per-person opt-out, an admin view of the lists or a "hide this line" for admins, sharing a prompt on purpose
(Copilot's way), suggestions in project chats or rooms, sentences in each viewer's own language (everyone sees the
team's language), more than one run a day, removing `GET /api/questions/frequent` and `GET /api/skills/popular` (no
screen reads them after this; a later cleanup).

## Steps

1. This plan (first commit).
2. Contract: `shared/src/api/chats.ts` `OftenAsked`, a strict union (`{ scope: 'team' | 'groups', items }` or
   `{ scope: 'group', group, items }`; at most 10 items of at most 80 characters) and `API.oftenAsked`
   (`GET /api/questions/often-asked`, auth user, owner B); `TeamSettings.oftenAsked`.
3. Migration `285_b_often_asked.sql` (B's range; #355 takes 284, check the highest on dev before merge), add-only:
   `often_asked_runs` (chat_id → chats `ON DELETE CASCADE`, user_id, material, created_at), `often_asked_items`
   (audience `team` or a group id `ON DELETE CASCADE`, position, text, passed_at), `group_member_since` (group_id,
   user_id, since; both `ON DELETE CASCADE`) with its insert trigger on `group_members`, and the settings row
   `oftenAsked.since`. No ids of people beside group membership, no counts.
4. Server: `chat/often-asked.ts` (the material, the words and their generic lists, the checks, the lists, the read for
   a caller) and `chat/often-asked-run.ts` (the turn, after `onboarding/file-rank.ts`, with its own-connection-only
   route); `turn.ts`/`tools.ts` (the refusals), the silent flag where the runtime publishes, `internal-chats.ts` (the
   mark), `chat/shared.ts chatFor` (the refusal), the daily timer, the route, the setting and its `since` reset
   (`admin/settings.ts`).
5. Web: `components/OftenAsked.tsx`; Home (remove the two sections, one slot); `TeamPrepared` (the 5-chat end of the
   skill rows; its callback says whether it shows anything); Admin › Team settings switch; mock server; `skillPrompt`
   moves next to its one other user (`AvailableSkills`); delete `PopularSkills.tsx` and `FrequentQuestions.tsx`.
6. i18n in five languages; DECISIONS entry ("Home: what my group often asks", amending B-W7-7 and W6.3); the changes
   note `changes/group-often-asks.md` (it tells members what counts, from when, and that nobody sees who asked);
   `docs/DESIGN-SYSTEM.md` Home line; `bun run docs:api`; `docs/for-admins.md` (the switch).

## Risks

- **Migration:** one add-only file in B's range (285 if #355 merges with 284), with a trigger on a foundation table.
- **Rollback:** an older build ignores the new tables. A run's chat that exists at that moment (minutes a day) would
  show in the owner's chat list there, as a file-pick chat would.
- **Privacy limits that remain**, written in DECISIONS:
  - People who agree to ask the same thing can still learn a little about the others; the floor of 5, the 3-day
    hold, join dates and the circle rule make it slow and vague, and an admin's group changes are in the activity log.
  - The checks cannot read meaning: a sentence made of words 3+ people share can still name a shared topic. Personal
    topics are left out by the instructions, not by a check.
  - The material (short first lines, masked) goes to the owner's AI provider. A member who uses their own AI account
    for chats has these lines sent through the owner's account too (an owner decision below).
- **Product:** QA rows TEAM-04 and PAR-13 expect the skills card on Home: update them. The newcomer skill rows now end
  after 5 chats (W6.3 changes). The list appears only after enough use, and never in teams under 5 askers.
- **Prompt injection:** an entry cannot reach a tool, and a sentence must be made of generic words and words 3+ people
  used, backed by 3+ people. At worst an odd sentence fills the box when someone taps it.
- **Phones and desktop:** one block in the place of up to three; 10 rows on a phone scroll.
- **Engines:** Claude Code, Codex (its instructions go in as a message: the tag breaking covers it) and the API engine.

## Tests

Server unit (`tests/unit/b-often-asked*.test.ts`, the fake engine answering set JSON):

- One person asking the same question 20 times never makes an item; two people never; three people do.
- The server counts people itself: an item whose ids come from 2 people, or 3 where one shares only generic words
  with the sentence, is dropped.
- Never in the material at all (the material is asserted, not only the list): project chats (own and shared), room
  AI sessions, side chats, Slack chats and turns, confidential chats, scheduled runs, server-made turns (a skill merge
  request), `auto_sent` messages, `/skill` runs, the server's own chats, deleted chats and messages, edited-away
  branches, disabled accounts, messages older than 30 days, messages sent before the switch was (last) turned on, the
  app's prompt templates.
- The masking: links, emails, numbers, secrets, `@` mentions, people's names (and surname + honorific), project and
  private room names never reach the material; group names do.
- The words: a customer name one or two people typed drops the sentence; so do a transliteration, a translation, a
  longer form, a particle not on the list, a Japanese sentence without spaces naming one person's client; digits,
  links, file names and masked names drop it.
- Circles: three people all in group H make no team item and no item for group G when H leaves out G's members; the
  same for a team project and a private room.
- Audiences: the team and a group under 5 askers have no list; a list under 3 items is not shown and the caller gets
  the team list; a non-member never gets a group's list; a question sent before someone joined a group does not count
  for it; several groups take turns.
- The 3-day hold: an item that stops passing stays 3 days, then goes; a list no run renewed for 3 days is gone.
- The switch off: the endpoint answers nothing, stored lists are gone, no run and no turn row; on: counting restarts.
- The route: a run never starts on the trial credit or the other engine; no owner connection or budget: no run.
- The run: every tool refused; zero events of any kind on the owner's connection; every chat route refuses its chat;
  deleted with its material after success, failure and a restart (sweep); a failure log holds no entry text.
- The response is strict: no counts or ids, no other person's name (the caller's own group name is the one name).
- Route coverage for the new route; the `chats`, `frequent-questions`, `internal-chats`, `team-settings`,
  `file-rank`, `groups` and `slack` area files.

Web: unit `often-asked.test.tsx` (3 rows, More/Less up to 10, a click fills and never sends, the three headings,
nothing when empty), `TeamPrepared`'s 5-chat end and its callback, the Home tests that named the two removed sections
(`home-no-ai`, `onboarding-polish`; `popular-skills` removed), the admin switch; e2e: `rankings.spec.ts` becomes
`often-asked.spec.ts` (fill, no turn, More, the switch off hides it, at 1440 and 390), `a11y.spec.ts`,
`no-ai.spec.ts`, `team-prepared.spec.ts`.

Always: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` +
`tests/unit/docs-site.test.ts`, `bun run test:web`, `bun run build:web`.

## Review

One independent review of the first draft (it tried to break the privacy rules and read it as a non-developer). Its
seven must-fix items are all taken: one floor for every audience, counted in people who asked (the draft had 5 members, for groups only; the review
said 10, the owner chose 5);
join dates and a 3-day hold against group-building and list comparing; words checked by two-character pieces and
word starts, no "AI's own word", and people backed only by a real shared word; the run never on the trial credit;
the newcomer skill rows end after 5 chats; only questions sent after the update count; one silent flag for every
event and the refusal in `chatFor`. Should-fix items taken: group and public room names stay, private rooms are
circles, Slack and server-made turns are out by an allow-list, app prompts matched as templates, 10 minutes and the
faster model, tag breaking for every tag, no engine output in logs, more tests. Nits taken: cascades, the rollback
note, the name scan, ties by text, one slot on phones, the queue place, the team's language. The switch's description
is shorter.

## Decisions (the owner, 2026-11-11: "끝까지 ㄱ", every recommendation taken, the floor at 5)

1. "My frequent questions" leaves Home (one list). Alternative: it shows in the same place when there is no team list.
2. A list needs 5 or more people who asked something, in the team or the group (the review proposed 10; the owner
   chose 5). Small trial teams see nothing.
3. Fall back to the team list for people without a group, or whose groups have none.
4. No personal switch.
5. The owner's AI runs it once a day, only on the team's own connection. A member who chats with their own AI account
   has these short masked lines go through the owner's account too.
6. Only questions sent after the update (and while the switch is on) count; the list appears after a week or two.
7. The newcomer block's skill rows end after 5 chats (today: never, until a team skill is run), so the list can show.

## Result

Filled in at the end.
