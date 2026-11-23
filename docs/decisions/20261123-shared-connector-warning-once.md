# Shared chats: one notice before a person's first use of a connection there, then no card

- Date: 2026-11-23
- Status: accepted
- Supersedes: the shared connection card of [20261118-shared-chat-connections.md](20261118-shared-chat-connections.md)
  ("Rule, when the card comes") and its Always of [20261122-connector-always-allow.md](20261122-connector-always-allow.md)
- Branch: fix/b5-flow2-3 (the owner, batch-5 measurement run, flows 2 and 3)

- **Ask:** in flow 2 a team "Aside" connection's tab list showed in a chat shared with 4 people with no card in one chat,
  and the AI refused in the other. The owner: "그냥 공유 프로젝트에서 처음 쓰기전에 노출될 수 있습니다. 경고 한번만 주고
  시작하면 되지 않을까?"
- **Rule:** the first time a person uses a connection (their own or the team's) in a shared project, or in a shared chat
  that is in no project, one notice comes first, to them only: "Other people in this chat can also see what the AI gets
  from <service>." / "이 채팅의 다른 사람도 <service>에서 가져온 내용을 볼 수 있어요." (a guest among the people is said),
  one button, Continue / 계속. Nothing is fetched before the press; no press (or a scheduled run before any press)
  fetches nothing. The press is kept per person, connection and place (`connector_tool_allow`, tool `\0seen:<place>`,
  bound to the connection's address and account like an Always), so no card comes again there, in any chat of the
  project. A new project or another shared chat outside projects shows it once again; a private chat never does.
  Settings › Allowed for Trina lists each one (the project's name or the chat's title) and removing it shows the notice
  again. An Always given on the old card still counts.
- **Rule, unchanged:** what a connection returns joins the answer's read record (k group): someone who joins later and
  may not use that connection does not see the answer. Team connections are refused while a guest sees the chat.
  Changes at a service keep their own cards (a team connection's change in a shared chat asks every time; the person's
  own Always holds).
- **Rule, the create tier in a shared chat:** a tool that only makes something new (20261123-do-then-undo.md) runs with
  no card in a shared chat where nobody else wrote, no room was read and nothing someone else wrote came in (it used to
  never hold there, since any shared chat counted as other people's words). The short answer of such a create (at most
  300 characters, no file, no link, not an error: "created v10") does not count as outside content that ends the tier.
- **Rule, one card per call:** a call of the same tool with the same arguments while its card waits (the AI called it
  again before the press) gets that same card, so one press runs it once (flow 3 made the app twice).
- **Why:** the per-answer card asked again in every answer (flow 3: 9 cards for 4 creates); a team connection everyone
  may use asked nothing at all, so people never learned the chat shows it. One notice says it once, where it matters.
- **Left out:** a "don't show again" switch (Continue always keeps it; Settings resets it).
- **Tests:** tests/unit/b-shared-connector-warning.test.ts; tests/unit/b-shared-chat-connections.test.ts.
- **Version impact:** minor (the shared connection card becomes a one-time notice per place).
