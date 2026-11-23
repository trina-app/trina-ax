# Ask registry findings: Always holds in scheduled runs and shared chats, fewer needless confirms

- Date (UTC): 2026-11-23 00:06
- Branch: `fix/ask-registry-findings` (stacked on `docs/ask-registry`, PR #421)
- Status: done
- Where: server (cards), web (Settings, a few confirms), desktop (local-app list). Why: the registry's findings
  (docs/ASKS.md "Findings"), decided by the owner under Rule A (docs/decisions/20261116-always-allow-final-rule-a.md)
- Version impact: minor, because Settings lists more allowances and the desktop bridge gets two calls (older apps
  keep working without them)

## Goal

Under Rule A, a person's "Always allow" is final. In some places it is still ignored. The registry also found confirms
that ask without a reason. After this PR:

- the person's own scheduled run uses their Always for move, copy, a copy after a room read, a download over 1 GB and
  AI video;
- with Always on, shared chats (and chats others wrote in) allow deletes and skill-folder changes;
- project member and folder access changes run under Always in the person's own scheduled run and in shared chats.
  The permission checks stay: the folder must be one they may manage, the subject must be one they can name, and they
  must be the owner or an admin. A run never gets more rights than the person has;
- 트리나에게 허용한 것 lists the connector send Always (removable there) and, in the desktop app, this computer's
  browser sites;
- Settings › Connectors lists the local programs connected on this computer, each with Remove (desktop app);
- the edit or regenerate confirm becomes a one-line notice; a restore with nobody else's edits lost goes without a
  confirm; the team setup's skip-invite confirm is gone; links in an Office preview open in a new tab with no confirm.

## Scope

In:

1. One shared fix for violations 1–4: `TurnPerson.alwaysOn(kind)` (chat/tools.ts turnPerson, read through
   `alwaysHere`, which keeps the guest limit). `askConfirm` (tools/url-gate.ts) answers `yes` in an unattended run when
   the card has an Always kind that is on, and otherwise `unattended` as before. The early throws in
   tools/file-moves.ts and tools/save-url.ts read it first. chat/places-copy.ts goes through askConfirm, so the
   one fix covers it.
2. Decision 1: chat/delete-files.ts `deleteFilesRefusal` and chat/skill-files.ts `skillFilesRefusal`. When
   `alwaysHere(...) === 'on'`, there is no `shared` or `others` refusal.
3. Decision 2: chat/project-members.ts `projectMembersRefusal` and chat/folder-access-tool.ts `folderAccessOff`.
   With Always on, there is no scheduled, shared or others refusal. Confidential, Slack, restricted, template and guest
   refusals stay. So do every permission check after it (mayManageProject / accessEditable, isStaff, whereOf as the
   person sees it, whoOf naming) and the existing per-call checks.
4. Decision 3: tools/higgsfield.ts reads `alwaysOn('video')` before its unattended refusal. The daily cap is checked
   before the card, as today.
5. Decision 6: a new allowance kind `connector_send` (shared/src/api/ai-allowances.ts). It is listed from the
   person's own connections with write rule `allow` and from their `integration_user_allow` rows. DELETE sets their own
   connection back to `ask` (audited, version+1) or deletes their row on a team connection (audited).
6. Decision 8: AiAllowances shows the desktop app's browser sites (public and office-network) when the bridge has
   them. The sites stay on the device. Remove uses the bridge's `removeSite`.
7. Decision 9: desktop bridge `localApps.connected()` (the connection ids confirmed for this team on this computer)
   and `localApps.forget(id)` (drops the confirm; the next call asks again; stops a running program). Settings ›
   Connectors gets a "Programs on this computer" list with Remove, in the desktop app only.
8. Decision 10: web Chat.tsx. Edit and regenerate no longer use `confirmDialog`. A one-line notice shows under the
   composer or the edited message when the replaced part saved files.
9. Decision 11: web Files.tsx restore. No confirm when `restoreDropouts` is empty. The widen confirm stays.
10. Decision 13: web InviteStep.tsx. "Later" skips without SkipDialog.
11. Decision 14: web OfficeView.tsx. Links open in a new tab with no `window.confirm`, through the same guard
    (http/https only, `noopener`).
12. Side findings: the skill-save label says "Always allow skill saves"; a full dev-site list does not offer
    "Always" (the card says the list is full and where to remove sites: DevEnvSiteRequest `listFull`); the
    office-network card follows the team Always switch (`siteGranted` reads only with the switch on; the card sends
    `noAlways` with it off, and an `always` answer then counts once).
13. Kept as deliberate exceptions, written in docs/ASKS.md: `schedule.create` (no Always; its card gets the note "asks
    every time: tasks run when nobody is watching"), `share.folder.stop` / `unshare.files`, `conn.write.noalways`,
    `ui.share.chatFiles`.
14. docs/ASKS.md: the rows above become OK (or OK, exception), the Findings and Summary are updated, and the Code index
    counts are corrected.

Out: chat-scoped Always (another PR removes it); `dev.login` Korean text; `conn.shared` and `guest.always_chat`
(chat scope, the other PR).

## Steps

1. Server: alwaysOn on TurnPerson, askConfirm, file-moves, save-url, higgsfield, delete/skill/members/folder refusals.
2. Shared API: `connector_send` allowance, `listFull` and `noAlways` on the request kinds; server list/delete.
3. Web: AiAllowances (connector_send rows, desktop sites), Connectors (local programs), Chat notice, restore,
   InviteStep, OfficeView, dev-site and office cards.
4. Desktop: localApps `connected` / `forget` over IPC.
5. Tests (below), docs/ASKS.md, changes/ask-registry-findings.md.

## Decisions

The owner decided these (Rule A, 2026-11-23). This PR adds a new file `docs/decisions/20261123-ask-registry-findings.md`
that lists them and the kept exceptions.

## Risks

- Who-can-see changes (members, folder access) in a run nobody watches: the run uses the person's own live principal
  and the same permission checks. Under Rule A, only their own Always counts. The guest limit stays in `alwaysHere`.
- Shared-chat deletes under Always: trash only (restorable), with the person's own rights (planAiTrash).
- Desktop bridge: the new calls are optional. An older app has no list, and the page hides it.
- No migration.

## Tests

- tests/unit/ask-registry-findings.test.ts: for each violation and decision, a scheduled run or shared chat with
  Always on runs without a card. With Always revoked (dropAlways), the card or refusal comes back. Also the
  connector_send list and delete, the full dev-site list, and the office card with the team switch off.
- Web tests: AiAllowances rows, Chat edit with no dialog, restore with no confirm, InviteStep later, OfficeView link.
- ask-registry.test.ts passes.

## Result

Built as planned. The plan review added: offering the three tools in a shared chat only under Always
(`SHARED_UNDER_ALWAYS`), the scheduled run's room-read refusals of deletes and skill folders under Always, the shared
chat prompt line, and an explicit guest refusal for members. The code review added: in a shared chat, folder access
only on a folder everyone there can open, and members only of the chat's own project (the result shows to everyone
there). Results under Always say "no card", never "confirmed". The desktop browser sites show in 트리나에게 허용한 것
in the desktop app only (not on a phone page, where the Browser part already lists them).
