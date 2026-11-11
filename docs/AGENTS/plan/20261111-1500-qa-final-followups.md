# QA final follow-ups: no admin named on a template, honest room line on a schedule card, no stale template row

- Date (UTC): 2026-11-11 15:00
- Branch: `fix/qa-final-followups`
- Status: done (PR open)
- Where: trina-ax core (`server/src/integrations/connections/templates.ts`, `requests.ts`, `service.ts`, `text.ts`;
  `server/src/tools/schedules.ts`; `web/src/components/integrations/TemplatesView.tsx`, `AnswerDialog.tsx`,
  `IntegrationRow.tsx`; `web/src/store/live.ts`; `web/src/pages/Connectors.tsx`; i18n; tests; DECISIONS)
- Version impact: patch; no data change. `MyIntegrationTemplate.createdBy` and a member's `IntegrationRequest.requestedBy`
  are always null now (fields kept, so older clients still parse).

## Goal (QA run on dev 1565b39f1)

1. A template's connect dialog said "최관리님이 팀을 위해 준비한 서비스예요", naming the admin. DECISIONS "Admins are never
   named": the member reads "A service your team set up for you" / "팀에서 준비한 서비스예요". The same holds for an
   admin's request to a member (banner, "Asked by …", the dialog): "An admin asked you…". The server stops sending the
   admin's name to members (template list for members; a member's own requests). Admin views keep names.
2. A schedule card listed rooms under "읽고 보내도 되는 대화" (may read and send). post_to_room refuses in a scheduled run
   (DECISIONS "Scheduled tasks: saving and sending allowed on the card"), and no other path posts to a room; a room on
   the card lets the run read it (and send to a pinned connection of the person's own after reading it, which the
   "Where it may send" line already says). The line becomes "읽을 수 있는 대화: …" / "Conversations it may read: …".
   No permission changes.
3. An admin changed a template's app: members' connections from it were dropped, but an open page kept the old row and
   its "다시 시도" said "찾을 수 없거나 접근 권한이 없어요" until a reload. Two parts, both in patterns the page already
   has: (a) when a member's connection made from a template is dropped, the server sends that member a quiet notice
   (`integrations_changed`, no text, like `profile_changed`) and the Connectors page reloads its lists; (b) an action on
   a row (check again, sign in, a tool switch, delete) that comes back not-found reloads the lists, as FromTeam's
   connect already reloads on 409.

## Tests

- `tests/unit/` template member view without the admin's name; member request view without it; the banner text.
- schedule card `scopeLines` rooms line in every language, without "send".
- `dropFromTemplate` publishes `integrations_changed` to each affected member once.
- web unit test for the not-found reload where a web test harness exists.
