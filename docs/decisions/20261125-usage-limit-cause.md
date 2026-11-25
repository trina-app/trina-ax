# A used-up AI limit says its cause: an admin's limit, or the AI account's own

- Date: 2026-11-25
- Status: accepted
- Supersedes: none (amends the member's words of `usage_used_up` from the owner report of 2026-11-19)
- Branch: fix/usage-limit-notice-home-chips (the owner, 2026-11-25; plan docs/AGENTS/plan/20261125-1735-usage-limit-notice-home-chips.md)

- **Ask:** the team's Claude subscription was used up (the model proxy's 403 `subscription_limited`) and a member read
  "<date>까지 쓸 수 있는 AI 사용량을 다 써서 지금은 답할 수 없어요. 관리자에게 AI 사용량을 늘려 달라고 해 주세요." No admin can raise
  a provider's limit.
- **Rule:** one place, web `lib/chatErrors.ts usageLimitOf`, tells the cause of a used-up answer from what is stored:
  - `budget`: a limit an admin set in Admin › Usage (the team's, a group's, the person's own; code `budget_exceeded`,
    not a free-roam demo's stop). An admin can raise it: the server's words stand (when it starts again; "ask an admin
    if you need more", a guest "the person who invited you").
  - `provider`: the AI account itself at its provider's limit for longer than an hour (reason `usage_used_up`,
    `params.until` when known). Nobody can raise it; it comes back by itself. The words (`usageLimitText`) by reader:
    the owner and admins, when it comes back and that another AI account in Admin › AI providers goes on now; a member,
    when it comes back, then wait or tell an admin; a guest, the same with the person who invited them.
  - The server's stored, role-blind words for `usage_used_up` (Slack, rooms, notifications) are the member's without a
    time. The old sentence stays in `LEGACY_CHAT_ERRORS`, so answers stored with it still read as `usage_used_up`.
- **Why:** "ask your admin to add more" sends a member to someone who cannot help; the cause decides who can.
- **Tests:** web/test/unit/chat-error-words.test.ts (each cause, each reader, every language).
- **Version impact:** patch (wording).
