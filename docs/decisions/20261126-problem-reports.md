# Problem reports go, signed, to the hosting service and land as one card in the operators' room

- Date: 2026-11-26
- Status: accepted
- Supersedes: none
- Branch: feat/problem-reports (product owner; plan docs/AGENTS/plan/20261126-0634-problem-reports.md)

Where: core (`web/src/components/ProblemReportSheet.tsx`, `server/src/system/problem-reports.ts`, the wire format
`shared/src/cloud-protocol/problem-report.ts`, MIT) and the hosting service's private control plane (the intake). Why:
the sheet, the allow-list and the signed sender are generic; the intake, the room's address and its credential belong
to the hosting service.

- **Ask:** "사용자가 불편 신고 하면 우리에게 이슈가 쌓이거나 하게 할 수 없나?", then: reports go into one channel of the
  operators' own team, like the Sentry "🤖 Trina Alert" room, and Settings has an entry point too.
- **Rule: two entry points, one sheet.** "문제 신고" in Settings › About under the version line, and 👎 under a finished AI
  answer. No account-menu item, no 👍. The sheet: one box "무엇이 불편했나요?", one line on who reads it ("Trina AX
  개발팀(포텐랩)이 읽어요"; on a self-installed server also that it leaves the server), from 👎 one tick "이 답변과 질문
  함께 보내기" with a preview, Send, "받았어요".
- **Rule: an allow-list, not a filter.** By default a report holds the person's words, the client kind, version and OS
  family, the server version and run kind, the engine and its pinned version, the locale, the kind of screen (a fixed
  word) and, from 👎, the turn id, the failure code (the codes error reports use) and the tool ids of the answer (a
  connection's tool and another MCP server's tool only as their kind, `mcp__team__connection` / `mcp__other`: their
  ids carry names people chose), never a step label (labels name files and items). The question and the answer only with the tick, only from the person's own
  chat of one person (shared, project and side chats: no tick in v1), each capped. No person's name, mail, team name,
  file or room name. A canary test plants them.
- **Rule: outbox, signed like the Drive broker.** The server stores the report (migration 703) and answers at once; a
  sender signs it with the relay team key over the Drive broker's string (method, path, ts, nonce, body sha256) and
  posts it to the console host's `POST /api/problem-reports/v1/report`. Backoff for 7 days; a 404 (an intake that takes
  no reports, or its flag off) and any other refusal are final. Once sent or dropped the body is deleted; rows go after
  30 days. Limits: 5 a person and 30 a team a day.
- **Rule: switches.** Admin › Team settings "팀원이 문제를 신고할 수 있어요", on by default (self-installed servers too:
  the owner's call, 2026-11-26), shown only where the server can send. `MYCEL_PROBLEM_REPORTS=off` removes the feature;
  `MYCEL_PROBLEM_REPORT_URL` names another intake origin. An edition without a hosted service, a dev server and a test
  app send nothing.
- **Rule: no special rules about the AI or the room.** The receiving room is an ordinary private room of the operators'
  team with an "Other" room app; the existing guards for chats that read rooms apply. Cards are written in English by
  the control plane; the person's words stay as written, neutralised (no links or mentions from customer text).
- **Why not the error-report channel:** error reports promise no words and no consent; a problem report is the
  person's own words by their choice.
- **Left out (later, if asked):** screenshots, more of the conversation than the 👎 tick, name and mail for a reply,
  "고쳤어요" notices, logs.
- **Tests:** `tests/unit/problem-reports.test.ts` (wire body, signature, canary, tick rule, outbox retry/404/expiry,
  limits, switch, env, Me); `web/test/e2e/problem-reports.spec.ts` (sheet at 1440 and 390).
- **Version impact:** minor (a new feature, a new team setting, a new outbound call).
