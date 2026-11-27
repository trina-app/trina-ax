# One Slack channel and one conversation, both ways: everyone in the conversation sees it

- Date: 2026-11-27
- Status: accepted
- Supersedes: [Slack: reading with the bot token only](../DECISIONS.md#slack-reading-with-the-bot-token-only-featslack-read-bot-token-2026-11-13-the-owner-qa-tc-879) (only its "nothing of Slack's messages is stored": a linked channel's messages are kept now)
- Branch: feat/slack-channel-relay (the owner; plan docs/AGENTS/plan/20261127-0329-slack-channel-relay.md, independent review)

- **Ask:** teams like ours cannot leave Slack, because their clients talk to them there ("이걸 릴레이 해주는 앱을 하나
  만들까", "UX가 편해야해"). Connect one Slack channel to one Trina conversation, both ways, so the team works in Trina and
  the client stays in Slack.
- **Rule, who connects:** a team owner or admin who is in the conversation, has their own Slack account linked and is in
  the channel (checked with the bot token), with the app in the channel. Team conversations and projects only; no
  guest in it. One channel per conversation, one conversation per channel. One dialog: pick a channel, one sentence
  says who will see, Connect.
- **Rule, who sees (owner decision 3, "슬랙은 이제 한명만 가입해서 쓰고, 나머지는 다 trina를 쓰기 위함인데… 그냥 admin이
  연결한대로 가야지"):** everyone in the conversation, with or without Slack. No per-member Slack check and no pausing.
  The admin's Connect after the sentence is the explicit authorization for the customer, who owns the data. Guests stay
  out in v1: a conversation with a guest cannot be linked, and a guest cannot be given a place in a linked project.
- **Rule, both ways (v1):** Slack messages come in under the sender's Slack name and picture, never as a team member;
  threads, mentions of linked people, edits and deletes follow. A person's own message goes to Slack as
  "Name (Trina)" (`chat:write.customize`; without it as the app with the name first). Not relayed out: messages that
  carry an AI answer, files, event lines, other apps' messages; each such message is marked "Not sent to Slack". A
  message that came from Slack is never sent back (no loop); each message's Slack (channel, ts) is kept once.
- **Rule, one app:** the relay is part of the existing Trina AX Slack app (one Add to Slack, one bot to invite). The
  new scope `chat:write.customize` is requested at every Add to Slack and required by no check; existing installs keep
  working and are not asked to re-add (owner decision 5: admins see one quiet line).
- **Rule, when the link ends** (disconnect, channel archived, app removed): the relayed history stays in the
  conversation, as a Slack shared channel keeps its history (owner decision 4).
- **Rule, the hosting service:** it never trusts a channel id a server names: it checks each with that install's own
  bot (`conversations.info` `is_member`), forwards only those channels' messages, routed by channel (two Trina teams in
  one Slack Connect channel), and drops every other channel's messages without keeping them.
- **Risk accepted by the owner (2026-11-27):** Slack's API Terms forbid "exposing private channel data to a user without
  access" and using the APIs "to replicate or compete with the Services"; the Marketplace names apps that "replicate
  Slack client functionality". Showing a linked channel to team members without Slack seats is the purpose. If
  Marketplace review objects, the relay is split into its own app or kept to teams' own apps then. The code keeps it
  apart (`server/src/integrations/slack/relay.ts`).
- **Left out (v1):** each person's picture in Slack, relaying AI answers and files out, reactions, back-filling history
  from before the link, 1:1 and group chats, several channels into one conversation, Slack Connect admin controls.
- **Privacy policy:** one bullet (trina-ax-website `src/legal/privacy.en.md`), merged before the release that ships it.
- **Tests:** `tests/unit/c-slack-relay.test.ts`, `tests/unit/c-slack-broker.test.ts` (relay/channels, dropped), the
  control plane's broker tests (trina-cloud), `web/test/unit/room-apps-slack.test.tsx`.
- **Version impact:** minor (a new feature, off until a channel is connected; an add-only migration, optional API
  fields, one new broker operation).
