# Phone notifications show who, where and the message, like Slack

- Date (UTC): 2026-11-24 10:14
- Branch: `fix/push-preview-slack-rule`
- Status: in progress
- Where: server (notifications, rooms, chat). Why: the owner sees phone notifications that only say "새 메시지가
  왔어요" / "새 메시지가 있어요"; Slack's rule is who, where and a preview, with a per-person switch.
- Version impact: minor (phone notifications of chats with people and thread replies change what they show; no
  migration, no new API field)

## Goal

Owner (2026-11-24): "그냥 다 보여주면 안되냐… 슬랙룰 따라가자." A phone notification for a message says who sent it
and where (title) and the start of the message (body), by default; each person can turn the text off in Settings ›
Notifications ("Show message preview in notifications", on by default; it exists since migration 275 and is renamed).

## Why it is generic today (what this fixes)

The push gateway never carries text: the phone asks its own team server for the words
(`POST /api/push/devices/:id/label`) only for codes `room.*` and `chat.shared`. Generic words show when:

1. A message in a chat shared with people or a project chat (`chat.message`): never asked, always "새 메시지가 있어요".
2. A reply in a chat thread (`chat.thread_reply`): never asked, always "스레드에 답글이 달렸어요."
3. A room message with only files or pictures: the label answer has no text, so the body is "새 메시지가 왔어요.".
4. A room message is answered with only its first line (a message that starts with an empty-looking line, or a
   greeting line, says little).
5. The phone could not ask (timeouts, http-only self-hosted team, old Android app, rate limit): the gateway's line.
   Not changed here (phone or gateway); reported.

## Scope

In:
- Server: phones get `chat.message` and `chat.thread_reply` under room wire codes (`room.chat_message`,
  `room.chat_thread`), so the existing iPhone extension and Android label service ask for the words with no app or
  gateway change. The label answer covers them: title "<who> · <chat title>" (thread: "… › Thread"), body the message.
- Body: the whole message as one line, at most 200 characters (not just the first line); files and pictures say what
  was sent ("Sent a photo", "Sent 3 files", "Sent a file: report.pdf").
- Never a secret: a message that looks like it holds a password, key, token, card number or one-time code
  (chat/auto-memory.ts secretIn) or a stored connection secret of its writer or reader shows no text.
- Safe operations (1A) on for the team: who and where only, never text.
- Setting renamed "Show message preview in notifications" (en source, ko), description says what it covers now.

Out: the gateway's own words and the phone apps (no deploy, no store release); web push (browser) and desktop
notifications; the own-AI-chat finished notice (`chat.answer_done`, a status, not someone's message).

## Steps

1. push-native: wire code map; Android `label` decided on the wire code.
2. push-service label: chat message and chat thread notices (delivered to this device, unread, wanted, still seen).
3. rooms/inbox: whole-message preview and file words for the label; secret check.
4. Settings wording (en.ts, ko.ts).
5. Tests: unit + security for the label answer (preview off: no text; secrets; safe ops; another person's notice).
6. Decision file, changes file.

## Decisions

`docs/decisions/20261124-push-preview-slack-rule.md`. Changes
`docs/decisions/20261121-android-push-who-where.md` and docs/DECISIONS.md "아이폰 알림의 이름" (codes asked).

## Risks

- Older phone apps: an iPhone app without the extension or an Android app without push-label-v1 shows the gateway's
  generic "You have a new message" for a thread reply (it said "Someone replied in a thread").
- Text on the lock screen: follows the phone's own setting (iPhone "Show Previews", Android "sensitive content").
- No migration.

## Tests

`bun run typecheck`, `bun run check:prepush`, `tests/unit/push-label*.test.ts`, the new
`tests/unit/push-preview-slack-rule.test.ts`, `tests/security/p4-route-access.test.ts`.

## Result

(at the end)
