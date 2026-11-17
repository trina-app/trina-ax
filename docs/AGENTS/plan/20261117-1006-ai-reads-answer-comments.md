# The AI reads the comments under answers in the chat it is in

- Date (UTC): 2026-11-17 10:06
- Branch: `feat/ai-reads-answer-comments`
- Status: done
- Where: trina-ax `server/src/chat/` (a new read-only tool, the prompt line), `shared/src` (its input and step label),
  `web/src` (the thread panel's note, the thread a window shows). Why: chat threads and the AI's tools are Team AX core.
- Version impact: minor, the AI can do something new in shared chats.

## Goal

QA MAN-003 (still failing on 0.5.12-dev): a member comments under an AI answer in a shared chat ("the laptop price is
now X"), the owner asks the AI to update the quote with it, and the AI answers that it cannot see comments and asks the
owner to press "Send to Trina" or type the price. The owner: "remove the can'ts", and give the agent a tool to look when
it needs to instead of feeding everything every turn.

## Scope

In:
- A read-only tool `answer_comments` (server/src/chat/answer-comments.ts). Only the chat the turn runs in:
  - with `message_id`: the comments under that answer;
  - without: the threads of this chat with comments, the most recent first, capped; the thread open in the asker's
    window when they sent the message (the turn's window snapshot) first.
  - Each comment one line: who, when (the asker's time zone), the text capped, our block tags neutralized, inside a
    data block with the room_read data note.
- Access: `threadAccess(…, 'view')` for every thread, as the asker now (the chat, the answer, an answer hidden from
  them). Only this chat's threads. A thread under an answer hidden from anyone who sees the chat now is not given (the
  AI writes where all of them read).
- Comments are other people's words, as room messages: the same marks as room_read (`markRoomsSeen`, which taints the
  session) plus `markOthersWords`, and the chat joins the read scope as `{type:'chat'}`. Rule A unchanged.
- Off: scheduled runs, Slack, confidential chats, template and restricted runs (actionOff), sub-agents
  (PARENT_ONLY_TOOLS and refused when reached). The remote connector has no chat turn. Offered only in a shared chat or
  a chat that still holds replies. Guests: on, for the chats they can open (only their own), as room_read is for the
  group chat they were invited to.
- Prompt: `sharedCommentsLine` ("You cannot read those comments") replaced by a line that says to read them with
  answer_comments when the user refers to them; without the tool, the "Send to Trina" button is named as the way.
- Copy: the step label and the thread panel's note ("reads them only when someone sends them") in 6 languages.
- looking_at is off in shared chats and covers room threads only, so it is not changed; the web reports the open chat
  thread (/c/:chatId/t/:messageId) in its `looking` frame so the tool can put that thread first.

Out: comments in the remote connector, search or export; a new card sentence for comments (the room one says "messages
from your conversations").

## Steps

1. Tool, input schema, step label, gates (SHARED_TOOLS, GUEST_TURN_TOOLS, PARENT_ONLY_TOOLS, read-only lists).
2. Prompt line, block tags, web note and looking frame.
3. Tests: access (own chat, another chat, a chat the asker can't open, a guest), the marks, the scripted MAN-003 flow;
   the tool lists in tests.
4. Changelog fragment, decision note (replaces MAN-003a), feature scope, docs.

## Decisions

docs/decisions/20261117-ai-reads-answer-comments.md

## Result

Built as planned. Two changes on the way: `{type:'chat'}` read-scope viewers now cover a team project's shared chat (it
was its creator alone, so a save into the project folder after a read asked as a widening), and its card label says
"files or comments in a shared chat". An independent review found no access hole; its hardening (plain-text comments:
every angle bracket, format character and line break neutralized; the hidden check repeated before delivery; one hidden
set for listing; "a guest" label) is in. Hands-on on a private copy of QA-Acme with the scripted AI: the comment's price
reached the quote after the room card.
