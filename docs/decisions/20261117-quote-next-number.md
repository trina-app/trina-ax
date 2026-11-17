# A number a skill shows is a format: the AI takes the next free one from the folder

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/quote-next-number (QA TC-4550; manual rows MAN-050, MAN-051)

- **Ask:** on qa.trina.app three quotes made with the QA-Acme team's quote skill (customers Sora Ltd, Hanbit Co and
  Mina Ltd) all got the number Q-20261117-01, in the same Quotes folder.
- **What qa showed (read only, 2026-11-17, times UTC):**
  - All three were made by one test account (a member), in its own Quotes folder, in three separate chats: Sora Ltd at
    02:03:51, Hanbit Co at 03:36:10, Mina Ltd at 03:40:06. Not a race between two testers: each later quote was made
    after the earlier -01 files were already in the folder (73 and 4 minutes apart).
  - The skill (`skills/quote/SKILL.md`, uploaded by hand by a tester on 2026-11-16, not made by the form-skill
    generator) says "Date and quote number (Q-YYYYMMDD-01)". Every run loaded it with the skill tool.
  - The Hanbit Co run listed no folder before make_file. The Mina Ltd run listed the Quotes folder (4 entries, two of
    them already Q-20261117-01) and still wrote -01: it copied the example in the skill.
  - On 2026-11-16, in a project folder, the same skill gave -01, -02, -03: those runs happened to list the folder and
    read the last quote first. So the result depended on whether the AI chose to look.
- **Rule:** every skill block the AI gets (a "/name" skill in front of the message, or the skill tool's result,
  `chat/prompt.ts` skillBlock) carries one fixed line, `RUNNING_NUMBER_RULE`: a quote, invoice or order number that a
  skill shows (Q-YYYYMMDD-01, No. 001) is only its format; before naming or numbering a new one, list the folder it is
  saved in and use the next free number after the highest one there (same day or series); never reuse a number or
  overwrite an earlier file; a revision of the same document keeps its number.
- **Why there:** hand-written skills (like this one) and form skills from the generator (`onboarding/form-skill.ts`,
  whose number blank the AI "works out itself") both reach the AI through skillBlock, so one English line covers every
  skill in every language, with no new card and no change to the skill files teams wrote.
- **Left out:** a server-side counter or a make_file check that refuses a used number. A counter would need to know
  each team's numbering format; the existing conflict copy already keeps an earlier file from being overwritten. Two
  people making a quote in the same folder within the same seconds can still get the same number; revisit if a real
  team reports it.
- **Tests:** `tests/unit/skill-running-number.test.ts` (the rule is in both the invoked and the loaded block, before
  the skill's own text). Real-AI check: a Quotes folder that already holds Q-<today>-01; make a new quote with the
  skill; expect Q-<today>-02.
- **Version impact:** server only; no migration, no screen text.
