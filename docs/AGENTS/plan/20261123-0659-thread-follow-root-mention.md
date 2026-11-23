# Thread replies reach the people mentioned in the root message

- Date (UTC): 2026-11-23 06:59
- Branch: `fix/thread-follow-root-mention`
- Status: in progress
- Where: server/src/rooms (Team AX core). Why: who follows a room thread is decided in rooms/service.ts follow().
- Version impact: patch (a bug fix: who follows a thread; no new setting, no migration)

## Goal

A room message that starts with "@depras" and gets six thread replies without a mention left depras with nothing:
follow() made the reply's author, the root's author and people mentioned in a reply follow the thread, never the
people mentioned in the root. In Slack you follow a thread you started, replied to or were mentioned in, the parent
included. After this change a person @mentioned in the root follows the thread from its first reply on and each reply
shows in Mentions & threads (and pushes when "Replies in threads I'm part of" is on).

## Scope

In: follow() adds the root's mentioned people (members now, who see the root) from root.seq, like the root's author.
`@everyone` in the root makes nobody follow (Slack: @channel does not subscribe). Comment at the top of service.ts and
the rule in a decision file.
Out: the push default. "Replies in threads I'm part of" stays off by default
(docs/decisions/20261122-project-chat-notices-threads-mention-only.md, migration 437; the web switch also reads a
missing value as off), so `preferencesOf(null).roomThreadReplies === false` is the documented default, not a bug.
There is no unfollow for room threads (no route, no flag), so re-adding on each reply overrides no choice.

## Steps

1. follow(): add `JSON.parse(root.mentions)` people who are members now and see the root, at root.seq (INSERT OR IGNORE).
2. Decision file docs/decisions/20261123-thread-follow-root-mention.md; service.ts top comment.
3. Tests in tests/unit/b-rooms-threads.test.ts: root-mentioned follows after the first reply and gets a notice (Inbox
   row); root author still follows; @everyone root adds nobody; a mentioned person who left is not added; no prefs row
   = thread switch off (quiet notice, not pushed).
4. changes/thread-follow-root-mention.md.

## Decisions

docs/decisions/20261123-thread-follow-root-mention.md (adds to "스레드와 반응" in docs/DECISIONS.md).

## Risks

Existing threads: a root-mentioned person starts to follow at the next reply, with the earlier replies unread in the
thread (they never saw them). No migration, no i18n.

## Tests

`bun run typecheck`, tests/unit room thread / notify / inbox tests, tests/security, `bun run check:prepush`.

## Result

(filled in at the end)
