# Read each field back before a web send, submit or post, and check the result after it

- Date (UTC): 2026-11-28 16:34
- Branch: `fix/irreversible-web-readback`
- Status: done
- Where: server/src/chat (the AI's instructions), tests/ai-scenarios (mock browser and flows). Why: the AI's rule
  for browser work is the instructions' job (docs/REPOSITORY-RULES.md).
- Version impact: patch. The AI's instructions for browser and app work change; nothing else.

## Goal

In the owner's session (2026-11-28) the AI wrote a mail in Daum Mail through Aside. The person attached a PDF and said
"첨부했어. 이어서 해", and the AI sent it at once with an **empty body**. Its script had put the body into another
field. Its check before sending searched the whole page for a sentence of the body, found it elsewhere, and called the
body filled. It checked To, Subject and the attachment in their own fields but not the body, and then said the body
held the apology and the amounts. On the retry it read the editor itself, showed a summary, asked, sent and checked the
Sent folder: that should be the first-time behaviour.

The cause is in the instructions, not in one site: the browser sections and the connected-services section only say
"ask before sending". Nothing says how to know what is about to go out, that a go-ahead does not skip that, or that the
result is checked afterwards. "Never claim what you did not see" (SHOWN_ONLY_RULE) is there, but a page-wide search
looks like seeing.

## Scope

In:
- One shared rule for actions on a web page that cannot be undone (send, submit, post, pay, delete), in the in-app
  browser, the person's own Chrome and connected apps that drive a browser (Aside and the like):
  - read back each field the action depends on from that field's own element (its value, the editor's own content,
    including one inside a frame, the recipient chips, the attachment list); never what was typed, never a search of
    the whole page;
  - give a short summary built from that read-back;
  - a go-ahead given before ("이어서 해", "send it") does not skip it: an empty or wrong field stops the action and
    the AI says which;
  - after the action, look where the result shows (a sent folder, a confirmation page, the post) and report only what
    that showed.
- Two general lines for every turn: a warning or request is said once and again only when it still matters; a way of
  working the person chose ("use Aside", "not the browser") holds for the rest of the task.
- Held-out measurement: a mock browser app for the AI scenario runner (a headless browser on made-up local pages:
  a webmail compose page whose body is a contenteditable inside a frame with a hidden mirror field, a form, a board
  post), 5 flows, run before and after on the Claude Code login engine.

Out:
- Changing the in-app browser's page script (form_input reporting what the field holds after it is set). It would be
  the structural version for the in-app browser, but the same script ships in the Chrome extension (a store release)
  and it does not cover Aside, where the incident happened. Left as a follow-up.
- Attaching team files through Aside (another PR).

## Steps

1. Plan (this commit).
2. Scenario runner: mock browser service (Playwright, made-up pages, state in the mock state file), a flow event that
   acts on the page as the person, 5 flows (FL-41..45). Commit.
3. Baseline run on that commit (the instructions as on dev).
4. The rule: one constant in server/src/chat/prompt.ts, used by both browser sections and the connected-services
   section; the two general lines in the base rules. Re-record the prompt pins. Unit test for where the rule shows.
5. After run, same flows, same engine.
6. Decision file, changes note, checks (typecheck, check:prepush, check:i18n, prompt unit tests under Bun 1.3.12), PR.

## Decisions

`docs/decisions/20261128-irreversible-web-readback.md`.

## Risks

- Prompt size: the rule goes where a browser or a connection is there, not into every turn. The two general lines go
  into every turn (short).
- Over-asking: the rule must not add a question when the person already said go and every field reads right.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `tests/unit/engine-prompt-pin.test.ts` and the
prompt unit tests, under Bun 1.3.12. The AI scenario flows FL-41..45 before and after.

## Result

- `WEB_ACTION_CHECK_RULE` (server/src/chat/web-action-rule.ts) in the in-app browser section, the Chrome section and
  "Connected services" (its instructions only: the context sent with every message has its budget); `ONCE_RULE` and `CHOSEN_TOOL_RULE` in every
  turn. Prompt pins re-recorded. Unit test `tests/unit/prompt-web-action-check.test.ts`.
- Scenario runner: mock browser app "Web Pilot" (`mock-services/browser.ts`, a team connection that runs without
  asking, as an Always-allowed app would; `AISCEN_BROWSER_TOOLS=script` offers only a script tool, as Aside's repl),
  flow step `page_act`, FL-41..45. Runner fixes found on the way: a flow's clean-up crashed on `r.turns`; an answer
  that follows the AI's own question ran unwatched into the next flow (it sent a mail on the next flow's page); each
  mocked flow now starts with no browser page.
- Engine for the runs: the product's Claude Code engine on the QA subscription token (dev server in managed mode, the
  token added as the team's AI connection), not this Mac's login. Judge: Sonnet on the same token.
- Measured (mechanical: no empty body or field sent, the asked text arrived, FL-45 never sent unasked; judge in
  brackets):
  - script tool (Aside-like): before 23/24 valid runs (judge 23/24; one run invalid, runner bug above); the failure is
    the incident itself: FL-41 sent an empty body after reading the hidden field back. After 25/25 (judge 25/25).
  - full tool set (snapshot lists frame values): before 10/10 (judge 9/10), after 10/10 (judge 10/10).
  - no extra questions: AI questions in FL-41/43/44 (the person said go) 1 before, 0 after.
- The held-out failure rate before was low (1 in 24 on the script tool); the change removes it on 25 runs but the
  sample cannot show a large effect. The in-app browser's own structural option (form_input reporting what the field
  holds) is left as a follow-up (it ships in the Chrome extension).
