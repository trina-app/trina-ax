# A connector's approval card says what the tool does: send, save, add, change or delete

- Date (UTC): 2026-11-25 09:39
- Branch: `fix/ask-card-action-verb`
- Status: done
- Where: server/src/integrations/connections (the change card of a connected service). Why: QA on qa.trina.app saw
  "The AI wants to send this… Send it? Send once / Don't send" on a Gmail draft and on a Calendar event
- Version impact: patch (card wording only; no API, no migration, no setting)

## Goal

The card before a change at a connected service always said "send", whatever the tool does: saving a Gmail draft and
adding a Calendar event read "The AI wants to send this to Gmail … Send it?" with "Send once" / "Don't send". A person
who wants a draft is told it will be sent. The card's verb must follow what the call does, for every connector tool.

## Scope

In:
- One general rule (`changeAction`, connections/card-lines.ts) that reads the action from the tool's name and title
  words, and for a "manage_*" style tool from its own `action` / `operation` argument (Google's `manage_event` with
  `action: "create"`): `send` (send, reply, forward, post, publish, share, invite, notify …; wins whenever it is said),
  `save` (draft, save, export), `add` (create, add, insert, append, upload …), `delete` (delete, remove, trash …),
  else `change`.
- The write card (tools.ts gate, also its shared-chat form) takes the sentence, the question, the buttons ("Save once"
  / "Don't save", "Add once" / "Don't add" …) and the details label from that action. Sending keeps its words.
- 6 locales (en is the source).
- An HTTP API request keeps "send this request" (it does send a request); the plain card of a call on the person's own
  things keeps its neutral "Allow" / "Don't allow".

Out: the model-facing refusal texts ("Nothing was sent …"); interim text placement (item 2 of the QA note: see Result).

## Steps

1. `changeAction` + unit tests (Gmail send/draft, Calendar manage_event create/update/delete, Docs/Sheets tools,
   generic MCP names, a send word winning over a create word).
2. text.ts: per-action sentence, question, once / yes / no, details label; tools.ts gate uses them.
3. Update tests that pinned the old "send" words on non-send tools.
4. changes/ask-card-action-verb.md.

## Decisions

docs/decisions/20261125-change-card-action-verb.md.

## Risks

A send that the words do not show (a tool named "create_post") must never read as a quiet change: any send word
anywhere in the name or title wins, and a "post" is a send. Nothing about who is asked or when changes: only words.

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit/c-* connector card tests, a new
tests/unit/change-card-action.test.ts.

## Result

Built, then turned around after the independent review of #585: send is the default, and the card says save, add,
delete or change only with a known action (Trina's Google list, or a clear non-send verb in a plain ASCII name or title
with no word that reaches people) and no sign in the call's arguments of anyone it reaches. A Gmail draft (Trina's list)
is the one tool whose recipients do not count.

Item 2 of the QA note (an interim line, "Nothing relevant yet. Let me widen the search…", above the final answer) is not
changed here. The text is not lost or invented: for an answer in Latin letters the text between calls stays in the
answer on purpose (docs/decisions/20261122-interim-text-not-answer.md, "as in Claude Code"). What differs from Claude
Code is the place: the web shows all steps in one block above the answer text, so the pieces written between calls
run together at the top of the answer instead of sitting between the calls they narrate. Moving them into a thinking
step (the ko/ja/zh rule) would hide them behind a click, below the Claude Code floor. The fix is a layout change (each
text piece shown at its Step.textAt among the steps, like the artifact cards), a follow-up of its own. A-28's summary
coming after both cards is the model's order of work: the card ends the turn and the answer goes on after the person
answers, as Claude Code goes on after a permission prompt.
