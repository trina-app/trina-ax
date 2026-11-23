# A person @mentioned in a thread's root message follows the thread

- Date: 2026-11-23
- Status: accepted
- Supersedes: none (adds to "스레드와 반응" in [docs/DECISIONS.md](../DECISIONS.md))
- Branch: fix/thread-follow-root-mention (owner report 11-23: a root "@depras …" then six replies without a mention,
  depras got nothing; QA TC-8140..8142)

- **Ask:** threads notify their followers and mentions exactly like Slack. In Slack you follow a thread you started,
  replied to or were mentioned in, the parent message included.
- **Rule:** when a thread gets a reply, the people @mentioned in its root follow it (room_thread_follows) from the root
  on, like the root's author: every reply after the root is new to them. Only people in the room now who see the root
  (a person who left, or who joined after the root, is not added). "@everyone" in the root makes nobody follow, as
  Slack's @channel does not. Room threads have no unfollow, so adding them again on each reply (INSERT OR IGNORE)
  changes no choice.
- **Unchanged:** how a followed reply alerts. "Replies in threads I'm part of" stays off by default
  ([20261122-project-chat-notices-threads-mention-only.md](20261122-project-chat-notices-threads-mention-only.md)): a
  followed reply without a mention is a quiet row in Mentions & threads and marks the root; it rings and pushes only
  with that switch on.
- **Left out:** an unfollow for room threads; AI chat threads (chat/threads.ts) keep their own rule.
- **Tests:** tests/unit/b-rooms-thread-root-mention.test.ts.
- **Version impact:** patch (a fix: who follows a thread; no setting, no migration).
