# Team servers send error reports only when the operator sets MYCEL_ERROR_REPORT_URL

- Date: 2026-11-19
- Status: accepted
- Supersedes: the "A hosted server refuses a key" rule of the unmerged PR #168 ("Error reports to Sentry"); everything
  else of that PR's approach is kept through `shared/src/sentry-report.ts`
- Branch: feat/hosted-error-reports (product owner, QA TC-5128 to TC-5143)

넣을 곳: Team AX core (`server/src/system/error-reports.ts`, the Admin › System line), 이유: the sender and its scrubbing
are generic and must be readable by anyone; the hosting service's address, key and retention stay in its private setup.

- **Ask:** the servers the hosting service runs for customer teams should tell the operators when they break (a crash,
  an AI answer that failed or stalled), so the team does not have to report it first. The open-source code must not
  carry the operators' address or key, and a server someone installs themselves must send nothing.
- **Rule: opt-in by one environment variable.** `MYCEL_ERROR_REPORT_URL` is a Sentry project key (DSN,
  `https://<public key>@<host>/<project id>`). Unset or empty: no reporter is built, no crash handler is installed, no
  request is made. Self-installed servers (office Mac, Docker, Linux) therefore send nothing unless their admin sets it
  to a project of their own. Not a server.json key: the operator's environment is the one place, so a team setting or an
  update cannot turn it on. A value that is not a Sentry key: one warning line at start, nothing is sent, the server
  starts as usual.
- **Same sender as the relay and the push gateway** (`shared/src/sentry-report.ts`, [the relay entry](../DECISIONS.md#error-reports-from-the-relay-and-the-push-gateway-featcloud-monitoring-2026-11-13-product-owner)):
  no Sentry SDK; `buildEvent` names every field of an event; the same scrubber; one copy of a repeated error a minute,
  at most 30 a minute, a crash always goes and the process still exits with 1; Sentry's 429 pauses sending. Sending
  never waits on the caller and gives up after 5 s, so a receiver that is down or slow cannot slow or break a chat.
- **What may be sent (the allow-list):**
  - every event: `release` (`mycel-server@<version>`), `environment` (how the server runs: hosted, selfhost, office,
    dev), `logger` `server`, tag `team_id` (`MYCEL_INSTALL_ID`, the hosting service's tenant id; left out when unset or
    when it does not look like an id);
  - an error line of the server log: the line's message (a fixed text written in code) and, when the line carries an
    error, its type, its message after the scrubber, and its code frames (the last two parts of a code file's name,
    function, line, column). No other field of the line;
  - a crash (uncaught exception, unhandled rejection): the same as an error line, level fatal;
  - an AI answer that **failed** or **timed out** (the stall guard): tags `outcome` (`failed` / `timed_out`), `reason`
    (the code the person's error message was made from, e.g. `rate_limit`, `credential_unusable`, `no_credential`,
    `stalled`; a code outside that list becomes `other`, none becomes `none`), `provider_status` (the AI provider's
    HTTP status when there was one), `duration_s`, `engine`, `model`, `user_id` (the person's internal id), `turns_1h`
    and `failed_1h` (answers that ended and that failed on this server in the last hour, so a rate needs no extra
    events). Answers that ended well, that the person stopped, or that an update or restart cut off send nothing.
- **What is never sent:** message text, prompts, AI answers, file names or contents, folder paths, email addresses,
  real names, team names, the team's address, chat or project ids, IP addresses, request paths or headers, keys.
  The turn report is built from codes in the database (`turns` status, the answer's `error.params.reason` and
  `params.status`), never from the answer's text or the error's words. `tests/unit/hosted-error-reports.test.ts`
  plants all of these and checks no body holds them, and checks the exact field list.
- **Admin › System › Server health** shows one line while it is on: "Error reports are sent to <host> to keep this
  server running." (the receiver's host name only, from `GET /api/admin/diagnostics` `errorReports.host`; owners and
  admins). No line when it is off. No new box, button or page.
- **Where the hosting service's config lives:** only in its private setup. Its address and key, the project, ~30 days of
  retention and turning it on for the servers it runs are set there (the team server's environment file,
  `/etc/default/mycel`, written when a server is created), never in this repository.
- **Privacy policy:** the hosting service's privacy policy needs one sentence saying hosted servers send error reports
  (what is in them, what never is, how long they are kept) and that self-installed servers send nothing. The wording is
  the hosting service's; it is not part of this repository.
- **Why not PR #168's hosted refusal:** that PR (07 Nov) refused a key on a hosted server, because a team's own admin
  could otherwise point the team's errors somewhere. On a hosted server the environment belongs to the hosting service,
  not to the team's admin, so the refusal would only stop the reports the operators need. Its browser reports
  (`POST /api/client-errors`) are not part of this change.
- **Left out:** browser errors; a report for every answer that ended well (quota; `turns_1h` gives the rate);
  Sentry's own SDK; alerts (the operators set them in Sentry).
- **Overlap:** the turn report is one call after `TurnExec.run()` in `ChatRuntime.runExec`
  (`server/src/chat/runtime.ts`); it reads what the turn's end saved and does not touch `chat/turn.ts`.
- Tests: `tests/unit/hosted-error-reports.test.ts` (off by default, invalid key, host only, outcomes, the reason code,
  the exact field list, content canaries, ids that look like emails, the per-minute limit, a receiver that hangs,
  refuses or fails, the log hook).
- Version impact: minor (a new optional setting and an optional field in the diagnostics answer); nothing changes
  without the setting.
