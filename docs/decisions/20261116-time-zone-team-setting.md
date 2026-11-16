# The time line in the AI's instructions says its zone is the team setting

- Date: 2026-11-16
- Status: accepted
- Supersedes: none
- Branch: fix/time-zone-team-setting (real-AI QA of dev after #1073 and #1066: QA TC-3700, TC-3702, TC-3711)

- **Ask:** TC-3700 (Partial after #1073): asked "is our team time zone set to Seoul?", the AI said it had not opened
  the setting and still answered "yes, Seoul". Make it check, or say it does not know and how to check.
- **Cause:** not the placement or wording of #1073's rule (`SHOWN_ONLY_RULE`). The time line of every turn's
  instructions (`chat/prompt.ts` `timeLine`) names the zone, and that zone *is* the team setting (`runtime.ts`
  `timeZone` = `teamTimeZone`, the value Admin › Team settings shows, its default included). The line did not say so,
  so the model held two things at once: "I did not read a setting" (the rule) and "the zone I was given is Asia/Seoul"
  (the line). It answered with both.
- **Rule:** the line adds one sentence, `<zone> is the team time zone, read from the team settings.` The AI can now
  answer from the setting it was given, which is the check: there is no tool that reads team settings, and none is
  needed for this one. Other settings the AI is not given stay under `SHOWN_ONLY_RULE` ("Not checked? Say so.").
- **Measured** (ai:scenarios runner, local dev server, fictional team, real AI): ADM-05 and the new variant ADM-05.ask
  ("우리 팀 시간대 서울로 설정돼 있어?"). Before: 5 of 6 answers said "not checked / not seen directly" and also "yes,
  Seoul" or "probably Seoul". After: 0 of 21 (three runs each of three prompt versions, the last one this change alone,
  9 of 9). The owner (ADM-05): "팀 시간대는 이미 서울(Asia/Seoul)로 설정되어 있어서 바꿀 필요가 없습니다 … 관리자 › 팀
  설정 › 일반 › 팀 시간대"; a member (ADM-05.ask): "네, 팀 시간대는 서울(Asia/Seoul)로 설정돼 있습니다 … 팀 소유자나
  관리자에게 요청해 주세요". About 25 tokens per call (measured on a one-call answer: 56,825 → 56,848–56,854 input
  tokens). They are not cached: the time line changes every minute and sits near the end for that reason.
- **Not done: interim notes in the answer language (TC-3702, TC-3711).** The suggested prompt change was tried and
  measured, and it did not help, so it is not in this change. Korean answers that keep an English line (#1066 keeps
  descriptive ones on purpose), over the same 69 Korean single-turn cases (ROOM-03, ORG-01, EDIT-04, FLOW-01, PDF-05,
  PDF-08 and 23 other first-pass areas with their variants) three times, plus the FL-19 flow three times:

  | prompt | cases | FL-19 | lines |
  |---|---|---|---|
  | dev as it is | 14 / 207 | 0 / 12 | "Only one thread exists; read it.", "Find the price list first.", "Files are loose at the top …; save there." |
  | `LANGUAGE_RULE` says the notes before a tool call are shown, with two such examples (+50 tokens) | 13 / 207 | 3 / 12 | the same kind, e.g. "Matches quote-writer skill. Load it.", "Need to find the CSV in team files." |
  | the same as the last line of the instructions, naming the answer language (+60 tokens, not for English) | 13 / 207 | 2 / 12 | the same kind, and once a German line ("Ich lese die 9 Dateien …") |

  The lines are the model's own terse notes before a tool call; a line in the instructions does not move them. A
  later fix belongs where the notes are made or shown (the engine, or #1066's hold), not in more prompt text.
- Tests: `tests/unit/b-review.test.ts` (the time line); `tests/ai-scenarios/cases.yaml` ADM-05.ask (the new variant)
  and ADM-05's expected answer (it is already Seoul, nothing to change).
- Version impact: patch (no API, no migration).
