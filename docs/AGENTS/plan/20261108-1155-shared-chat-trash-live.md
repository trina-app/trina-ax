# Shared chats: a deleted project's chats go to the trash, the editor's trash, live lists

- Date (UTC): 2026-11-08 11:55
- Branch: `fix/shared-chat-trash-live`
- Status: in progress
- Where: trina-ax `server/src/routes/chats.ts`, `server/src/chat/shared.ts`, `server/src/admin/folders.ts`, `web/src/`.
  Why: shared project chats are Team AX core chat behaviour (see docs/REPOSITORY-RULES.md)
- Version impact: minor, an add-only migration (`chats.deleted_by`) and changed behaviour of project delete and the
  trash list

## Goal

A design audit of dev found three problems with shared project chats:

1. Deleting a project purged every shared chat of it at once, while deleting one shared chat puts it in the trash for
   the team's retention. The bigger action was the one that cannot be undone.
2. A project editor who deletes someone else's shared chat cannot find it in their own trash (the list shows only
   their own chats), and the delete confirm names a screen, "삭제한 채팅", that does not exist ("삭제한 기록").
3. Shared chat lists do not follow access changes or live events: someone who loses the project folder keeps the chat
   in their sidebar (it opens to a 404), and an open project page never shows a chat someone else just started.

## Scope

In:

- Project delete (owner decision): each shared chat goes to its creator's trash, as a single delete does, and comes
  back as the creator's chat without project. It stops being shared, like a chat the rollback guard unshares, and keeps
  the several-authors rules; what each viewer sees of other people's turns stays per viewer. A chat whose creator does
  not see the project then (lost its folder, or the account is gone) is deleted for good as before: nobody could
  restore it, and giving it back would show its creator what they lost. Everyone else who saw a chat hears it is gone.
  The confirm drops the red "deleted for good" line for the plain wording, naming the trash by its i18n key.
- The trash lists the shared chats I deleted too (a new `chats.deleted_by`), while I may still restore them (I see the
  project and may edit it), once each. The single delete's confirm names the trash by `sidebar.trash`.
- Access changes (`afterAccessChange`): whoever stops seeing a project gets `chat.updated` 'deleted' with no chat for
  each of its shared chats. The chat list reloads on the access notice. The project page applies chat events of its
  project (new, renamed, deleted, restored, moved).

Out: unsharing a chat by hand, a repoint or a folder moved to the trash (they change a project's audience outside
`afterAccessChange`), a per-chat restore choice, live faces on the project page (they come with the list).

## Steps

1. Migration `274_b_chat_deleted_by.sql`: `chats.deleted_by` and a partial index.
2. `routes/chats.ts`: delete sets `deleted_by`, restore clears it; the trash list adds the shared chats I deleted that
   I may restore; project delete moves shared chats to the creator's trash (unshared, without project) or purges them
   when the creator does not see the project, and tells the audience.
3. `chat/shared.ts`: per-viewer message views also for a chat several people wrote in; who lost which project in an
   access change. `admin/folders.ts` sends the removals.
4. Web: confirm texts (5 languages), the chat list reloads on `access_changed`, the project page follows chat events.
   The web mock follows the server.
5. DECISIONS (replace the old project-delete line), CHANGELOG, API summaries.

## Risks

Migrations: 274 (dev's highest is 272; 273 is taken by fix/shared-chat-audience). Permissions: the trash must not list
or restore a chat the caller no longer may manage; a removal event names only the chat id. A restored chat must not
show its creator more of other people's turns than they saw while it was shared. fix/shared-chat-audience changes the
same files (`chat/shared.ts`): rebase on it if it lands first.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the unit tests of chats, projects and folders,
`tests/security/shared-project-chats.test.ts`, `bun run test:web`, `bun run build:web`, `bun run docs:api` with
`tests/unit/docs-site.test.ts`, and the full web e2e.

## Result

Filled in at the end.
