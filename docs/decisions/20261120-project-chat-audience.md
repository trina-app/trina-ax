# A project's chat count leaves its guests out; its file count keeps them

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (follows "Guests: only what they were invited to" in the [archive](../DECISIONS.md) and the
  AP-056 fix of `Chat.shared.audience`)
- Branch: qa/1120-admin (AI parity QA leftover LEFT-1)

- **Ask:** in a team project with a guest, the new-chat box's "N people" chip and the faces in a shared chat's header
  still counted the guest, though a guest opens only their own chats there (`Audiences.ofChat`). The line under an open
  chat was already right (AP-056).
- **Rule:** `Project.chatAudience` is who can open a chat the caller starts in the project: `audience` without the
  project's guests, the caller always counted (a guest's own chat is seen by the members and by them). The chip, its
  sentence and the shared-upload line use it (`chatWho`, an older server's `audience` otherwise). The header's faces are
  the project's people without its guests, except the guest who started that chat (`chatOpeners`).
- **Kept:** `Project.audience` is still who reads its files (the 멤버 line, the folder-access chip, the project's faces
  under its name, the channel link confirm), and the guest counts there.
- Tests: `tests/unit/b-shared-chats.test.ts`, `web/test/unit/who-sees.test.tsx`.
- Version impact: **patch** (an optional field and a fix; no breaking change).
