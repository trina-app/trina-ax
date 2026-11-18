# The API engine takes the team's tool rounds per answer

- Date: 2026-11-19
- Status: accepted
- Supersedes: the API engine line of docs/DECISIONS.md "Tool rounds per answer" ("the API engine keeps its own 30
  rounds")
- Branch: fix/audit1-api-engine (limits audit 1 #31)

- **Before:** the API engine stopped every answer after 30 tool rounds. The reason given was that it "is not
  budget-checked per round". That is no longer true: the turn checks the budget before every round after the first
  (`beforeRound: checkBudget`, tests/unit/b-budget-mid-answer.test.ts).
- **Now:** a chat turn on the API engine gets the same cap as Claude Code's `--max-turns`: `answerStepCap` of the
  team's `answerStepLimit` (Admin › Team settings, default 500, 10-500), at most 150 for a guest and at most 150 for an
  unattended run (a scheduled task, a question from Slack). At the limit the answer pauses with Continue, as before.
  Callers that give no limit keep 30.
- The admin hint says the setting applies to Claude Code and the API engine.
- Unchanged: Codex has no round cap; sub-agents keep their own rounds; budgets apply between rounds.
