# Demo company "Acme" (the open example)

The default content of `bun run demo:company` (format: [`scripts/demo/company/README.md`](../company/README.md)).

**Acme is a fictional company.** Every person, customer, number, policy and document here is made up for the demo; the
website `acme.example` is a reserved example address. There are no photos or logos.

Acme has six people and sells Acme Desk, a desk-booking app for offices. The viewer starts as **Alex Kim**, who joined
the Marketing team today, and can switch to **Sam Ortiz** (Marketing lead) or **Dana Brooks** (CEO) to ask the same
question: "Summarize this quarter's budget". Dana gets the company's $100,000, Sam only Marketing's $45,000, and Alex
only the November campaign's $12,000 from the team folder, because the budget folder is closed to them.

```bash
bun run demo:company            # server 19830, relay 19831, data ~/.acmedemo
bun run demo:company --local    # this Mac only
```

## Who sees what

| Path (under `files/`) | What | Who opens it |
|---|---|---|
| `shared/handbook/leave-and-benefits.md`, `shared/onboarding-guide.md` | leave, benefits, the first week | everyone |
| `shared/budget/2026-Q4-company-budget.xlsx` | Q4 operating budget, $100,000 | Dana only |
| `shared/budget/teams/<team>/` | each team's Q4 budget | Dana and that team's lead |
| `groups/Marketing/` | November campaign plan, brand voice, the weekly meeting notes (Nov 3) | Marketing, Dana |
| `groups/Sales/pipeline.xlsx` | eight deals by stage | Sales, Dana |
| `skills/meeting-action-items/`, `skills/answer-rules.md` | a team skill and a team rule | everyone |
| `skills/work/` | the work pack's natural-writing skill (taken from `resources/skill-packs/work/en`) | Marketing, Dana |

People: `dana` (CEO, a member who reads more through rules), `sam` (Marketing lead), `alex` (new hire), `jordan`
(Marketing), `priya` (Sales lead), `leo` (Sales); password `teamax-demo-1` (public). The owner `acme-admin` has a random
password in the data folder's `owner-password`.

The numbers agree: the company sheet's team lines are the team sheets' totals, and the Marketing sheet's November
campaign line is the plan's $12,000. The spreadsheets are made by `bun tests/demo/make-acme-files.ts` (it refuses to
write when a total drifts); the Markdown is written by hand.

## Recordings

`recordings/` holds three answers the real AI (Claude Code, 2026-11-05) gave once, written down by
`scripts/demo/company/record.ts`: Alex's one-page Word brief of the campaign and Sam's Excel task sheet from the
meeting notes (suggested on their Home and replayed in seconds, the files made again by the product's tools as that
person), and Dana's pipeline summary (a past chat from yesterday).
