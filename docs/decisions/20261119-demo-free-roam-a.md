# A free-roam demo is a demo kind on a development server, with every dev flag hidden

- Date: 2026-11-19
- Status: accepted
- Supersedes: none
- Branch: feat/demo-free-roam-a (the owner's free-roam demo plan, 2026-11-19, part A)

- **Ask:** after the scripted Mina demo, a visitor gets their own real server ("Now try it yourself") behind
  demo-gate. They are signed in as Mina in the fictional company, the AI is real, and they can roam until a
  weighted token limit. Visitors never see a development server and never see which AI account answers. The server must
  refuse, whoever asks, everything a visitor must not reach.

- **Rule: the run mode.** We had two choices: allow demo mode outside dev with a new `demo` run kind, or keep dev mode and
  hide every dev flag. **We keep dev mode and hide every dev flag.** The demo file says `"kind": "freeRoam"`
  (shared/src/api/demo.ts DemoFile). Production mode needs the installer's world: the launcher socket, the role account
  (`engine.agentUid`), the install base, prod paths, the cgroup and HWP isolation checks and the Codex catalog. One
  instance per visitor, cloned from a folder on one Mac, has none of these. A new run kind would have to fake each one,
  or touch about 30 `mode === 'prod'` branches. Dev mode already runs the engine without them. In freeRoam these dev
  flags are turned off:
  - the DEV badge: `me.server.dev` is false (auth/service.ts);
  - the developer page instead of the web app: `WebOptions.dev` is false (routes/web.ts);
  - the relay's default team name (relay-client/index.ts). The relay is refused anyway, see below;
  - debug logs: info is the default, and `logLevel: debug` is refused;
  - update, machine diagnostics, connection change and office update: off in the feature table (system/deployment.ts
    FREE_ROAM_OFF, on top of DEMO_OFF).

  `MYCEL_DEV_ENV=1` is refused, so the dev environment never exists.

- **Rule: where it may run.** readDemoFile (app-config.ts) accepts freeRoam only when all of these hold:
  - `engine.authMode` is `managed`;
  - `listen.host` is 127.0.0.1, localhost or ::1;
  - there is no relay URL, and no TLS, tunnel or tailnet;
  - there is no `anthropicGateway`;
  - `engine.modelUpstreams.anthropic` is an http(s) address on loopback. A path is fine: it is the gate's
    `/i/<instanceId>.<secret>`.

  It must also be dev mode, not the hosted service and not office mode, as for any demo. The file has exactly one person
  (`personas`). The free-roam fields (`limitTokens`, `signupUrl`, `uploadFileMax`, `uploadTotalMax`) are refused on a
  scripted demo.

- **Rule: the AI connection.** At start (demo/free-roam.ts startFreeRoam, from routes/demo.ts):
  - the server makes one team `anthropic-oauth` connection named "Demo AI" when it is missing. Its token is a random
    stand-in shaped like CLAUDE_TOKEN_RE. It has no expiry and is marked as checked;
  - its marks are cleared, and every other connection is switched off;
  - team subscriptions are turned on, and members' own connections are turned off.

  The proxy sends the stand-in as a Bearer with the OAuth beta, and the gate puts the real token in its place.
  The stand-in only ever goes to the gate:
  - the model upstream is the gate, and readDemoFile refuses any other;
  - a check (verifySecret: adding, replacing or checking a connection, all fenced anyway) returns "unverified" and
    sends nothing;
  - markInvalid, markNoCredit and markNeedsReconnect do nothing to a free-roam server's connection (credentials/store.ts
    standIn);
  - a long 429 ends the answer, but the connection is not held out until it resets. In
  freeRoam no upstream answer marks the stand-in: not a 401, and not a 400, 402 or 403 (proxy/model-proxy.ts `marks`,
  broker.freeRoam). Such an answer is passed on as it came. A loopback upstream normally "speaks for the account"
  (anthropic-refusal.ts), but here it is the gate. The one exception is the gate's own stop: a 403 `budget_exceeded`
  (its daily cap or PAUSE). That becomes the turn's budget event with `demoRest`, and the answer ends as a budget stop:
  "The live demo is resting, try again later." (params.reason `demo_rest`). Every other failed answer reads "The demo is
  busy, try again in a bit." (params.reason `demo_busy`; its other params are dropped, because they can name a
  subscription limit's time). Only the demo limit and the gate's rest keep their own words (demo/free-roam.ts
  freeRoamTurnError).

- **Rule: the demo limit.** This is one limit for the whole instance. The instance has one visitor and lives at most a
  day, so the limit has no period. The weighted tokens are uncached input + cache writes + output + 0.1 × cache reads.
  - **The weight:** credentials/broker.ts `record` writes cache reads at DEMO_CACHE_READ_WEIGHT into `turns.input_tokens`,
    on a free-roam server only.
  - **The count:** admin/budgets.ts `demoUsed` adds up the turns whose usage the proxy counted (`usage_source = 'proxy'`).
  - **The check:** `budgetBlock` checks the demo limit before the team's budgets. So a send is refused with
    `budget_exceeded`, params `{ reason: 'demo_limit', used, cap }`. The model proxy's `overBudget` ends a running
    answer with its 403 `budget_exceeded` and the turn's budget event, never a 529. Scheduled runs and the file list
    stop the same way.
  - **GET /api/demo** now also says `kind`, `used`, `cap` and `signupUrl`. The default limit is 300,000; the demo file
    can set `limitTokens`.
  - **Not a budget row:** we did not use the per-user `budgets` row the plan named (insertGuestBudget). Its period is a
    month, so a visitor whose day crosses the 1st would start again at 0. And it would count turns already in the
    snapshot. **Contract for the snapshot builder (PR C):** the snapshot holds no proxy-counted turns. Run the canary on
    a clone, not on the base.

- **Rule: the fences.** demo/guard.ts refuses these whoever asks: the visitor, the owner's account, or someone signed
  out.
  - **Endpoints** are refused before the request's body is read (http/route.ts → freeRoamFence): 403, params
    `{ reason: 'demo_fenced', area }`. The list:
    - **admin:** every `/api/admin/…` endpoint and every endpoint for admins or the owner;
    - **account:** setup, login, change password, password reset, app sign-in (pairing), account deletion. Changing your
      own name or e-mail is refused too (updateMe, updateMyProfile); the language and other preferences can still
      change;
    - **invite:** invites, guest invites, team links (the whole group);
    - **connect:** AI access requests, members' own AI connections and their sign-ins, Drive, Google apps and
      integrations (connect, sign in, change, remove), templates, service requests. Remote MCP, Slack and room apps are
      refused as whole groups. Kept: the Slack status read and the room's app list and icons;
    - **background:** scheduled tasks (create, change, run now, review), web push and phone devices, connect-info (the
      server's addresses), the desktop app's computer report, the in-app browser and local apps;
    - **heavy:** the dev environment, voice (transcribe), the MP4 render of a promo video, plugins.

    The test lists each endpoint and checks the answer.
  - **Off-contract routes** answer 404 in freeRoam: every route but the web app's, its WebSocket and the app links
    (RouteKit.raw). That covers the OAuth callbacks, room app webhooks (`/in/…`), the remote MCP server and its OAuth
    routes, and connector uploads.
  - **Uploads:** the four upload endpoints take at most 10 MB per file. All uploads on one instance together take at
    most 100 MB; the count is kept in settings and survives a restart. A file over the limit gets 413 with params
    `reason: 'demo_upload'`. The demo file can change both limits.
  - **Turn tools** are filtered in chat/tools.ts `add`. The model proxy refuses any tool the turn was not given
    (checkToolNames), so a sub-agent or an older engine cannot call a refused tool either. WebSearch and sub-agents
    (Agent) are off in every turn (chat/turn.ts → engine/claude.ts `--disallowedTools`; Codex: no web search). Bash,
    Read, Write and WebFetch were already denied. The AI gets the demo line (chat/prompt.ts demoRule, next to
    devEnvDownRule).

- **The turn tool registry, allowed or refused in freeRoam:**

  | Tool | freeRoam | Why |
  | --- | --- | --- |
  | list, glob, grep, read, write, edit, edit_files | allowed | the visitor's own file work, under Mina's folder access |
  | make_file, edit_hwp, hwp_render, stamp_pdf, edit_pdf, merge_pdfs, split_pdf, resize_images, unzip_file, make_zip, query_data | allowed | documents from team files, no outside address |
  | share_file, artifact, comment_docx, edit_office | allowed | in the team folder |
  | move_files, copy_files, rename_file, rename_files, delete_files | allowed | in the team folder, behind their cards |
  | save_connector_file | allowed | saves what a connection (the fakes, PR B) returned |
  | intro_deck | allowed, without step "read" | its site reader fetches addresses the visitor names: refused |
  | remember, forget, ask_user, todo_write, set_title, looking_at | allowed | the chat itself |
  | skill, find_skills, move_skill, skill_files | allowed | the demo's team skills |
  | rooms, room_read, room_file, save_room_file, post_to_room | allowed | the demo's rooms |
  | share_with_person, stop_sharing, share_folder, who_can_open, shared_with_me, change_folder_access, change_project_members | allowed | sharing inside the fictional team, behind cards |
  | chat_file, save_chat_file, answer_comments | allowed | the chat's own files and comments |
  | Gmail / Calendar / Docs / Sheets, Drive (drive_search, drive_list, drive_read), Higgsfield (generate_video …) | allowed | connection tools; demo mode answers them with fakes (PR B), anything else refused without a socket |
  | connect_service | refused | connecting new services |
  | schedule_create, schedule_list, schedule_delete | refused | background work |
  | web_fetch, save_url | refused | the visitor would pick what this machine fetches |
  | promo_video, save_promo_video | refused | heavy work (a video render) |
  | box_shell | refused | the dev environment (also off: MYCEL_DEV_ENV refused) |
  | preview_start, read_page, computer, form_input, navigate, find, get_page_text, javascript_tool, read_console_messages, read_network_requests, resize_window, tabs_*, browser_batch | refused | the desktop app's in-app browser (device work, any address) |
  | Slack reading (provider "slack") | refused | its API calls go straight out |
  | WebSearch, Agent (sub-agents) | off per turn | the plan's fences |

- **Rule: demo-gate's folders (review fix, 2026-11-20).** Instances run as their own user (demo-gate `pool.runAs`), so
  the gate's credential file is not theirs to read. On top of that, a free-roam server's converter sandbox
  (tools/isolate.ts) never reads `/private/var/demo-gate` nor the gate's state and secret folders, which the gate passes
  as `MYCEL_DEMO_GATE_DIRS` (demo/free-roam.ts startFreeRoam → setDemoDenyRead). Other servers are unchanged. The
  engine sandbox (scripts/macos/engine.sb) denies by default and opens none of them. GET /api/demo says `builder: true`
  while the builder is on; the gate takes an instance only when it says `kind: "freeRoam"` and no builder.

- **Left out:** the fakes (PR B), the Steepling content, the snapshot builder and the canary (PR C), demo-gate and the
  web's free-roam screens (PR D), hosting. Some AI calls happen outside a turn: the chat history summary and the file
  list's nightly reading. If they do not go through the turn's proxy token, they are not in the instance's count, and
  only the gate's daily cap bounds them. The instance's server.json can turn the file list off (`fileList.enabled: false`).

- **Tests:** tests/unit/a-demo-free-roam.test.ts (the config checks, Mina's sign-in, the Demo AI connection, every
  fenced endpoint for three callers, the raw routes, the uploads, the weight and `demo_limit`, the turn's tools and
  flags, and the proxy's marks and budget path).

- **Version impact:** none for any installed server (demo mode only).
