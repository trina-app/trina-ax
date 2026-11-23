# One card for many; a card never carries a skill's whole text

- Date: 2026-11-23
- Status: accepted
- Supersedes: the "every word on the card" rule for skill_files (docs/DECISIONS.md "Skill folders: the AI's file actions": text past 60,000 characters refused)
- Branch: fix/batch-cards (the owner: "스킬 여러개 만들라고 하니깐 한번에 저렇게 다 띄워 버리네", "항상 허용하면 뒤에것들은 안해도 되어야지", "무거운것도 문제야", "뭔 이런 어이없는 이유가 있냐")

- **Ask:** several skills made at once gave one huge card per skill, stacked; a 15-file skill was refused because its
  text did not fit on a card.
- **Rule:** server cards of one answer with the same group key (`AskUserRequest.batch.key`: the tool's own, else
  `tool:<name>` stamped in TurnExec.waitForPerson) and the same buttons are shown as one card; one press answers each
  card in order (unticked items get their card's last option, sent first), now or later (waiting cards). "Always allow"
  on any card of a kind answers every other open card of that kind of the same answer with it (live: TurnExec.answer;
  waiting: open-questions recordAnswer), and later cards of that kind in the answer raise none. The skill cards
  (skill_files into a skill folder, move_skill) lead in plain words; their question, names, paths, the start of SKILL.md
  (12,000 characters) and the files by name and size, each opened in the file viewer on request (`ConfirmDetail.open`),
  are behind "자세히". No skill is refused for the length of its text; the press still binds every byte (the token).
- **Why:** a team-wide skill keeps its ask (every teammate's AI follows it), but once per answer, not once per skill, and
  a person reads what they want to on demand instead of scrolling 150k characters.
- **Left out:** the phone app still shows each card on its own; one endpoint that answers many cards at once.
- **Version impact:** patch.
