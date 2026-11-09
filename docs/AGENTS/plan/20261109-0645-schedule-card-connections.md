# The schedule card offers only the connections the task names

- Date (UTC): 2026-11-09 06:45
- Branch: `fix/schedule-card-connections`
- Status: in progress
- Where: trina-ax `server/src/tools/schedules.ts`, `server/src/chat/schedule-edit.ts`, `server/src/chat/schedule-review.ts`. Why: the scheduled-task card is core chat and permission code (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a scheduled task may send to fewer connections; no API, setting or data format change

## Goal

Every schedule card named every "allow" team connection the person can use ("이 연결 서비스는 AI가 묻지 않고 보내도록
설정돼 있어요: …") with three buttons, also for a news briefing that has nothing to do with them. The card should name,
and offer sending to, only the connections the task needs. With none, the card has no connections line, the plain
create / deny buttons, and runs send to no connection.

## Scope

In:
- `schedule_create` takes an optional `connections` list: the "allow" team connections a run must send to, by name
  (or the `team_<slug>` key of their tools). A name that is not such a connection is refused before the card.
- A connection whose name is written in the title or the instruction counts as named too (the same whole-name rule as
  a template named in an instruction, `namesTemplate`).
- Edit (Settings): named in the edited title or instruction, plus the ones the task may already send to.
- Review ("다시 확인"): named in the title or instruction.
- The card's request id binds only the connections it offers.
- The tool description tells the AI to name the connection when a run must send there.

Out: the card's wording and buttons, the address checks, `allowed_urls`, the run-side gate. No web change.

## Steps

1. `taskConnections` in `tools/schedules.ts`; `schedule_create` input and description.
2. Edit and review use it.
3. Unit tests; DECISIONS entry; CHANGELOG line.

## Risks

Strictly fewer sends: the offered set is a subset of today's. A task whose instruction needs a service but does not name
it cannot send there in a run (it says so in the run). No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every `tests/unit` file that mentions schedules.

## Result

Filled in at the end.
