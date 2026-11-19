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
    error, its type, its code when it is a fixed word (`ENOENT`, `EACCES`, `ERR_…`) and its code frames (the last two
    parts of a code file's name, function, line, column), read from the stack after the message. **Never the error's
    own message:** it is often built from a name, a file or a person's text ("Folder Kim Minsu not found"), and no
    scrubber can tell plain words from a name. No other field of the line;
  - a crash (uncaught exception, unhandled rejection): the same as an error line, level fatal; the full error still
    goes to the server's own stderr, and the process still exits with 1;
  - an AI answer that **failed** or **timed out** (the stall guard): tags `outcome` (`failed` / `timed_out`), `reason`
    (the code the person's error message was made from, e.g. `rate_limit`, `credential_unusable`, `no_credential`,
    `stalled`; a code outside that list becomes `other`, none becomes `none`), `provider_status` (the AI provider's
    HTTP status when there was one), `duration_s`, `engine`, `model`, `user` (a stand-in for the person, see below), `turns_1h`
    and `failed_1h` (answers that ended and that failed on this server in the last hour, so a rate needs no extra
    events). Answers that ended well, that the person stopped, or that an update or restart cut off send nothing.
- **The person is a stand-in, not the internal id.** `users.id` is made from the username (`auth/users.ts`
  `deriveUserId`), which is often a person's name, so sending it would send a name. The report carries
  `u_` + the first 16 hex of HMAC-SHA256(user id) under a random key made on first use and kept only in this server's
  settings (`system.errorReportSalt`). Reports of one person can be told apart; who it is can be found only with this
  server's database. The key is one of the server's own settings (`SERVER_OWN_SETTINGS`): a restore keeps the
  current one.
- **One person's run of the same end is one report a minute** (outcome, reason, person), because the duration and
  rate tags make every report different for the shared sender's repeat rule; across people the shared limit of 30 a
  minute holds.
- **What is never sent:** message text, prompts, AI answers, file names or contents, folder paths, email addresses,
  real names, team names, the team's address, chat or project ids, IP addresses, request paths or headers, keys.
  The turn report is built from codes in the database (`turns` status, the answer's `error.params.reason` and
  `params.status`), never from the answer's text or the error's words. `tests/unit/hosted-error-reports.test.ts`
  plants all of these and checks no body holds them, and checks the exact field list.
- **Admin › System › Server health** shows one line while it is on: "Error reports are sent to <host> to keep this
  server running." (the receiver's host name only, from `GET /api/admin/diagnostics` `errorReports.host`; the owner,
  who is the one who sees Server health). No line when it is off. No new box, button or page.
- **Where the hosting service's config lives:** only in its private setup. Its address and key, the project and turning it on for the servers it runs are set there (the team server's environment file,
  `/etc/default/mycel`, written when a server is created), never in this repository.
- **Retention: 90 days** (owner, 2026-11-19). The hosting service keeps reports in its Sentry project on the plan it
  already has, which keeps error events 90 days and cannot shorten that; no deletion job and no plan change.
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
