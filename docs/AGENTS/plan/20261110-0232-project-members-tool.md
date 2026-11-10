# change_project_members: the AI changes a project's members behind one server card

- Date (UTC): 2026-11-10 02:32
- Branch: `feat/project-members-tool` (on `feat/project-members-panel`, which is not merged yet: whoever merges second
  rebases)
- Status: done
- Where: trina-ax core (`server/src/chat/`, `server/src/rooms/ai-tools.ts`, `shared/src/`, one detail field in the web
  card). Why: chat, permissions and AI tools are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new AI tool and a card; no API change, no migration.

## Goal

Asked to add or remove people in a project, the AI said it had no tool. The owner (2026-11-10): "이것도 가능하면 좋지
않을까?" This adds `change_project_members`: the AI names the people and groups as the user wrote them, the server
resolves them and shows ONE card with the project, everyone added and removed, what opens to them and who is told; only
[멤버 바꾸기] changes anything, through the same save as the members panel (the rules hash checked inside the
transaction). Owner decisions: no 보기/편집 split; the tool also works in chats that read rooms, the ✦ side chat
included, with the review's M1 (side chats and quotes count as having read rooms) and M5 (the red "내 메시지에 없는
이름이에요" mark).

## Scope

In (the review's revised plan B, all MUSTs and SHOULDs, N1–N7):
- Input `{ project?, add: [{ name, id? }], remove: [{ name, id? }] }` (shared/src/tools.ts); at least one name. No list
  mode, no `kind`, no username or email matching (cut by the review).
- Where it runs: the person's own chat only. Refused up front with `refusal()` texts in a scheduled run, a room, a
  shared project chat, a confidential chat, a chat other people wrote in, a Slack question or a Slack thread's chat
  (`exec.fromSlack`, S1), a draft / judge / merge chat (refused when called, N7), and for a sub-agent
  (`PARENT_ONLY_TOOLS` and `files !== exec.files`). Not offered in rooms, shared or confidential chats (the
  allowlists), nor in an approved template run; never in `FILE_TOOLS` or the remote connector. At most 2 cards per
  answer, none after a no or no answer, none while another card is open (`exclusive`).
- Read rooms (M1): `rooms_seen`, a side chat (`side_room_id`) or a `>` quote in the person's messages on this branch.
  Then the card leads with the room line (`roomsSeenWhy`), as post_to_room's; the tool joins
  `ROOMS_SEEN_READ_ONLY_TOOLS` with a comment (N6), so no second room card.
- Project: the chat's project, or `project` by name or folder among the projects the person sees. Personal, in the
  trash, or not theirs to change: refused (the creator named only while active and able to, S7; an admin never).
- Names (M2, M3, N3): NFKC, case folding, invisible and direction-control characters removed, spaces folded, and a
  small look-alike map (Latin/Cyrillic/Greek); a name must match exactly one person or group across every kind of match,
  or the answer lists candidates (with an `id` each) and nothing is asked. An `id` counts only when it is one of that
  name's candidates. Remove: a unique partial match among the current members, 2+ characters. One message for "not a
  member". Adding: active people and the groups the caller may name.
- Plan check (M4 B): the rule difference must be exactly the named people and groups; a save that would also add the
  floor rule or put the creator back is refused, pointing to the members panel. The creator cannot be removed; a person
  or group with a rule from Admin › Folder permissions is refused.
- The card: the project; each line person or group, the full name, a group's head count (S2), "같은 이름 N명" when
  another account folds to the same name, the red "내 메시지에 없는 이름이에요" on a name (and on a project other than
  the chat's) not in the person's own messages outside `>` quotes (M5); how many gain and lose it, what opens to them,
  "이 부서에 나중에 들어오는 사람도 보게 돼요" for a group, what removal does (N4, no "reversible"), who is told (N1), an
  admin removed by an admin keeps access (N2). A new optional `ConfirmDetail.alerts` draws the red marks.
- Yes: bound to a fingerprint (rules hash, the next rules, who sees it before and after, every skill name: N5), checked
  again with a re-plan, then `saveParticipants` (hash inside the transaction), audited `folder.rules` with `via: 'ai'`
  and one `projects.ai_members` row per call.

Out: names for members who cannot change a project; a list mode; anything on the members panel (PR A).

## Steps

1. This plan.
2. `planAccess` in project-access.ts (previewAccess maps it; same endpoint answer), `saveParticipants` audit option.
3. `server/src/chat/project-members.ts`: names, the gate, the plan, the card, the yes; registration, lists, prompt line,
   step label, five languages.
4. `ConfirmDetail.alerts` and the web card's red marks.
5. Tests, including the attack tests; docs, DECISIONS, CHANGELOG.

## Risks

Prompt injection is the main one: a room message, a quote, a file or a page asking the AI to add someone. Bounded by: only
active accounts, the server's card (the AI cannot write it), every name in full with its kind and the red mark, the
fingerprint, the same server checks as the panel. Look-alike and duplicate names: ambiguous unless an `id` from that
name's candidates. No migration (highest on dev: 701). Five languages.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `docs:api`; new `tests/unit/b-project-members-tool.test.ts` (names,
every refusal, the card, the attacks, the yes, the race, the audit), the project, chats and rooms suites, the security
permission matrix and remote connector coverage, the whole `tests/unit` against dev, web unit tests (the red mark) in
Docker, the project e2e specs.

## Result

Built as planned. From the security review of this branch (two must-fixes, then a re-review with none left): the red mark
looks only at the subject's own whole name as a word in the person's words (never the name or project alias the AI
gave: a part of a name or a look-alike picked by its id would pass otherwise), and reads the newest 200,000 characters of
them; two accounts of one name cannot be told apart on a card, so an admin's card shows the account's username and
anyone else is sent to the members panel; a step after the save that fails is reported as saved. delete_files's own
side-chat gap (M1) was closed by #313, whose shared `readRooms` rule this tool now uses too. An independent re-check of the PR found one more must-fix: a person named
like a group's on-screen label ("영업 부서") was the only match for "영업 부서 넣어줘"; groups now go by their labels in every
language, so that is a same name. From the same re-check: room titles in the message do not count as the person's
words, more look-alike letters fold, an honorific or a group word after a name still matches, and a part of a name only
one member has counts as a mention when an honorific follows it ("민재님"; a bare part such as "park" or "미래" stays red,
from a second re-check); DECISIONS calls the red mark a mention check.

PR: https://github.com/trina-app/trina-ax/pull/310 (stacked on #298)
