# A scheduled run is "with problems" only when something needs the person

- Date (UTC): 2026-11-11 06:37
- Branch: `fix/run-problems-only-real`
- Status: done
- Where: trina-ax core (`server/src/chat/schedule-outcome.ts`, `server/src/chat/turn.ts`,
  `server/src/integrations/connections/tools.ts`, their unit tests). Why: scheduled runs and connection sends are core
  (docs/REPOSITORY-RULES.md).
- Version impact: patch; no API, data or screen change

## Goal

A weekday news briefing (a scheduled task that searches the web and writes a summary) shows "Last run finished with
problems / Some steps did not work" although its answer is complete. Today every refused or failed tool call
(`tool_events.ok = 0` or a step with status `error`) makes a run `problems`
(`server/src/chat/turn.ts`, `scheduleRunOutcome`). In an unattended run, a `web_fetch` of an address the chat never
showed is refused (nobody can confirm the card), and pages time out or answer 4xx/5xx; the AI answers from the search
results anyway. Those reads changed nothing and need nobody.

A second QA finding: every scheduled run that saves a file and then sends a summary to a pinned connection is
`problems`, because the summary names the saved file (`주간보고_2026-11-11_2.md`) and `.md` is a country suffix, so
the send is refused as carrying a host name (`integrations/connections/tools.ts` `hostNamesIn`).

## Rule after this change

`problems` only when the person has something to act on:
- a call that would change something (save, send, post, delete, remember, a sub-task …) was refused or failed;
- or the answer paused at a per-answer limit (as before). `failed` (no answer, error, stopped, interrupted) as before.

A refused or failed look-up (read, search, list, web search, web_fetch, drive/room reads, browser reads, a connection
call that only reads) the AI worked past does not count. The server log keeps their number.

In a pinned send, a name with an underscore (no registrar issues it) or exactly the name of a file this run saved is
not a host name. Any other registrable name (`evil.md`, `attacker.zip`, `x.attacker.zip`) still is (security review).

## Steps

1. Test that reproduces it: a scheduled run with a refused `web_fetch`, a failed `read` and a complete answer.
2. Look-up classification next to the outcome rule; the turn notes connection calls that only read.
3. File-name exception in `hostNamesIn`; tests.
4. TC-019-style refused save, failure, stopped, interrupted keep their outcomes.
5. DECISIONS.md, `changes/run-problems-only-real.md`, checks, PR to dev.

Out: UI changes (no new boxes), `tools/url-gate.ts` (PR #351).
