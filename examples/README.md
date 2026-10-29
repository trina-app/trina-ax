# Copy a team skill

[한국어](README.ko.md)

These files do not install themselves. A skill manager can create `skills/<name>/SKILL.md` in the app's **Files** view and paste the matching [skill file](skills/meeting-summary/SKILL.md), preserving its folder name and YAML header. For example: folder `skills/meeting-summary`, file `SKILL.md`, name `meeting-summary`. Upload the input files to `shared/demo/`. Members can suggest a skill for review by the target folder's skill manager.

Give the person read access to the skill and every source folder. `shared/demo/` is suitable for these fictional examples only; real HR/finance inputs should be restricted. A skill never grants extra permissions. Check Team skills for loader warnings. A malformed header or name/folder mismatch is not loaded as a skill.

| Skill / role | Fictional input | Human review |
|---|---|---|
| `meeting-summary` | [meeting-notes.md](data/meeting-notes.md) | The meeting owner checks every decision, assignment and date. |
| `weekly-team-report` | [sales-week.md](data/sales-week.md), [finance-week.md](data/finance-week.md) | The team lead checks totals, period and decision status. |
| `sales-follow-up` | [sales-meeting.md](data/sales-meeting.md), [follow-up-style.md](data/follow-up-style.md) | The salesperson checks promises, tone and recipients before sending outside this skill. |
| `new-hire-guide` | [onboarding-policy.md](data/onboarding-policy.md), [office-guide.md](data/office-guide.md) | HR confirms that the policy is current and appropriate for this role. |
| `brand-brief` | [brand-guide.md](data/brand-guide.md), [campaign-notes.md](data/campaign-notes.md) | Marketing verifies factual claims, brand tone and publication approval. |
| `expense-review` | [expense-policy.md](data/expense-policy.md), [expenses.csv](data/expenses.csv) | Finance checks each amount and receipt and makes decisions separately. |

Open a new chat, select the skill, or type `/meeting-summary Read shared/demo/meeting-notes.md`. Use the corresponding slash name for each row. Ask for your preferred output language. Review the cited source, uncertain facts and output before any real use. Saving is optional and requires a permitted location; sending/publishing/approval is outside these examples.

[All skill files](skills) · [Fixture notes](data/README.md) · [Illustrative result](data/example-result.md). The local quick-try command disables AI: you can inspect skills/files there, but a real run needs a permitted AI connection in a separate environment.
