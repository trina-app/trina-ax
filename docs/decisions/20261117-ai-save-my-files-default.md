# The AI saves new content in My files unless a place is named, and says who can open it from the folder

- Date: 2026-11-17
- Status: accepted
- Supersedes: none (narrows "Save new work … (their personal folder by default)" in the turn instructions into a rule;
  rewords the wider-audience card of [DECISIONS.md](../DECISIONS.md) without changing when it asks)
- Branch: fix/ai-save-my-files-default (QA TC-4792, Manual AI tests MAN-026 and MAN-027)

- **Ask:** in a 3-person room's ✦ side chat the AI saved a summary to Company-wide › Meeting notes, which 10 people can
  open. The card said "Trina read content fewer people can see (messages of the conversation leads) and now wants to
  save to Company-wide > …, which 10 people can see. Save it?", and the answer then said "everyone in the room can open
  it". 20261117-room-notes-not-company-wide.md fixed the group-chat fallback; the general instructions still steered
  meeting notes and filled forms to Company-wide (its purpose line, "saving the new document where it belongs").
- **Rule (where):** new content the AI makes (a summary, notes, a file built from a link, a chat or a room, a generated
  document) goes in the person's own folder, users/<id>/ (My files), unless the person names a place or the task clearly
  names one: a skill's steps, the chat's project, the side chat's room save place (the two room decisions below), a
  scheduled task's folder. A file made from an existing file (a PDF of a deck, a resized picture) still goes next to
  it, as the rule on where files go says (AI flow FL-15). The AI never picks a team folder because the content looks
  like it belongs there, and does not ask where first. Not for a guest (their own placement rules stay).
- **Rule (card):** the wider-audience card is unchanged in when it asks, its buttons and Always allow
  (20261116-always-allow-final-rule-a.md, 20261117-card-approved-once-per-chat.md). Its words: "This came from
  <source> (3 people). Save it to <place> (10 people, 7 of them can't see where it came from)?"; each source with how
  many people can see it now, "(only you)" for the person alone; a place someone else opened in a shared chat keeps no
  count. The second number is always said: the card asks whenever anyone at the place cannot see a source, also when
  the place holds no more people than the source (an overlap: "3 people" from, "3 people" at the place, 1 of them
  new), so the counts alone must never read as safe. It is missingReaders (the place's readers minus each source's
  viewers), counted by the same reader as widening() (the chat's creator). The skill card's line says the same.
- **Rule (who can open):** each new file's save result ends with "Who can open the new file now …", worked out from the
  real folder (rules and folder shares): only the user, everyone in the team (N), or N people; in a side chat also how
  many of the room's people and how many outside. The AI says who can open a file only from that line or from
  who_can_open (20261116-ai-share-who-can-open.md), never from the room. It has who_can_open's gates: no line in a
  confidential chat, a scheduled run, a Slack question or a template / restricted run, none for a guest or a
  sub-agent; in a shared chat (others read the answer) only "only the user" or "everyone in the team", never a count
  of the asker's folders. People are loaded once per tool result; a team past 2,000 active people gets no line (as the
  folder access counts).
- **Kept:** the room save places of 20261116-flow-regressions-0512-save-place.md and
  20261117-room-notes-not-company-wide.md (a team room: its group folder; the Everyone room: Company-wide; a group chat:
  the smallest group folder, with the card when the group is wider than the room, or My files and a share with the
  room). They are a place the task names.
- **Tests:** tests/unit/b-ai-save-place.test.ts; tests/unit/b-guests-prompt.test.ts; tests/unit/plural-counts.test.ts;
  tests/unit/b-skill-save-one-card.test.ts; ai-scenarios SAVE-01 (personal, named, room-side).
- **Version impact:** patch.
