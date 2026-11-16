# Threads on AI answers: QA fixes (TC-3887, TC-3888, TC-3889) and the TC-3625 question

- Date (UTC): 2026-11-16
- Branch: `fix/chat-thread-qa-fixes`
- Status: done
- Where: trina-ax core: `web/src/store/chatThreads.ts`, `web/src/components/chat/ChatThreadPanel.tsx`,
  `web/src/pages/Chat.tsx`, `web/src/pages/Projects.tsx`, the language tables. Why: the chat screens are core
  (docs/REPOSITORY-RULES.md).
- Version impact: patch (fixes, no API or migration)

## Goal

QA of the threads rows on dev (df0c929) left three small fixes and one question.

## Scope

- TC-3625 (question): "Error: unknown tool 'change_project_members'" after Send to Trina + "add them to the project" in a
  shared project chat. Finding: deliberate. A shared chat's tools are an allowlist (`rooms/ai-tools.ts SHARED_TOOLS`);
  `change_project_members` and `delete_files` are not on it, so a real engine is never offered them, and the shared
  chat's prompt tells the AI to say plainly that changing members (or the trash) is not available here and to suggest
  "Continue privately". "unknown tool" is what `tools/registry.ts` answers to a call of a tool that was not offered: the
  fake engine forced that call. No code change; a test pins the allowlist and the prompt line. The QA row should use a
  card that is reachable in a shared chat (see the PR).
- TC-3887: replies sent fast stacked one "You're sending fast" toast per waiting reply. Now one line under the reply box
  while any reply of that thread waits out the budget; the replies still go by themselves.
- TC-3888: Esc (or ✕, or ‹) put the focus on the page. Now it goes back to what opened the thread ("Reply in thread" or
  the line under the answer); a thread opened from a link goes back to its answer's line. Not after Send to Trina on a
  phone (the box takes it) or when a file panel replaced the thread.
- TC-3889: "You're no longer a member of 'THR Gone'" (quotes, no full stop). A sentence in all six languages, no quotes,
  the name in `<bdi>` (chat and project pages); the server's message the same.

Out: nothing else.

## Decisions

None (fixes within docs/decisions/20261116-chat-answer-threads.md).

## Risks

Low: web only, plus one server message's wording.

## Tests

`web/test/unit/chat-threads.test.tsx` (one line for five waiting replies, no toasts, all posted; the sentence in six
languages with `<bdi>`), `web/test/e2e/chat-threads.spec.ts` (focus back after Esc, ✕ and a link-opened thread),
`tests/unit/b-chat-threads.test.ts` (TC-3625: the shared chat's tools and prompt), typecheck, check:i18n.

## Result

As planned.
