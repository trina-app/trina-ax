# Pick the AI model and how hard it thinks; see your use per model

- Date (UTC): 2026-11-26 04:20
- Branch: `feat/model-effort-choice` (the MVP, one PR; the plan was reviewed on `plan/model-effort-choice`)
- Status: done (owner approved the recommendations 2026-11-26; review changes below; built as one PR)
- Where: server/ (B: `server/src/chat`, `server/src/engine`, migration; A: `server/src/admin`, `server/src/credentials`),
  shared/src/api, web/. Why: the choice is made per turn by the chat engine, recorded by the model proxy and shown in
  Settings and Admin (docs/REPOSITORY-RULES.md, docs/WORKPLAN.md section 5).
- Version impact: minor. A new visible choice and new usage rows; the API fields and the migration are additive, old
  apps keep working.

## Review changes and owner decisions (2026-11-26, these win over the text below)

- **Owner decisions, locked:**
  1. Who can choose: **new teams start with everyone** (`engines.memberChoice` = everyone, written when the team is
     set up). Existing teams keep their setting. New decision file
     `docs/decisions/20261126-model-effort-choice.md` (reverses "AI 엔진·모델은 관리자가 정한다" for new teams).
  2. Names: real model names with one plain hint line each. Effort 빠르게 · 보통 · 꼼꼼하게 = `low` / no flag / `high`.
     No `xhigh`, no `max`.
  3. Opus stays the default as today. **No Opus allowlist.**
- **Cut from this MVP (do not build):** `engines.strongModelWho` and the step-down line, any Opus allowlist, the
  "Sonnet으로 계속" button, the "limit almost used" notice, the person × model admin bars, API-engine effort.
- **Recording, corrected:**
  - Migration **456** (`456_b_model_effort.sql`; 455 is taken by open PR #586). Check again before pushing.
  - **`turns.model` is not overwritten.** It is the *requested* model: a queued turn rebuilt after a restart reads it
    back as `--model` (`chat/runtime.ts` requeue paths). The real model lives only in `turn_models`.
  - `turn_models(turn_id, model, source, requests, input_tokens, output_tokens, cost_usd, est_cost_usd)` follows the
    `usage_source` rule of `credentials/broker.ts`: the first proxy row of a turn **replaces** its engine-report rows,
    later proxy rows add to proxy rows, and engine reports never write once a proxy row exists. No token is counted
    twice.
  - Sources: the model proxy (`message_start.message.model`, Codex response `model`) through `broker.record`; engine
    reports when no proxy counted: Claude Code `result.modelUsage` keys, Codex the turn's launched model.
  - Haiku rows from Claude Code's own background calls are real usage; the hint says so plainly, not as a fault.
  - Settings › Usage and Admin › Usage "by model" read `turn_models` (old turns without rows fall back to
    `turns.model`). A display-name map in `shared/` turns `claude-opus-5-5-…` into "Claude Opus".
- **Choice, corrected:**
  - Claude Code: `--effort low|high`, nothing for 보통; the `--help` check stays (the pinned 2.1.305 has the flag).
  - Codex: `-c model_reasoning_effort="low|medium|high"` is always sent, 보통 included (`medium`), also when nobody
    chose a depth (보통 is what the picker shows then): some Codex models default to `low`.
  - API engine: unchanged.
  - Scheduled runs carry the owner's default depth; a run into a shared chat uses that chat's model and depth (fixes
    `schedules.ts` deciding the engine before the chat).
  - The model hint depends on the person's connection: limit (한도) wording on a subscription, cost wording on an API
    key.
  - Team default depth in Admin › Team settings › AI defaults (settings key `defaultEffort`).
  - All six locales, en.ts the source, plain 해요체 in Korean.

## Goal

The owner asked for a place to switch between Sonnet and Opus and set the effort, and for each person's usage to show
per model: "advanced 같은 설정 만들어서 거기서 sonnet, effort 같은거 바꿀 수 있게 … 각자가 얼마 썼는지에서 모델 별로
나오긴 해야겠네 … AI에게 메시지 보낼때 advanced 설정이 있어야하나? 다른 챗지피티 처럼?"

Users are not developers. They should be able to pick a faster or a more careful answer the way they do in ChatGPT or
claude.ai, without having to learn what an engine is. Admins should be able to keep a shared subscription from running
out because everyone uses Opus.

## What exists today (dev 507580e0b, read in code)

- **Model choice is already built.** The composer has an AI picker (`web/src/components/chat/EngineMenu.tsx`,
  `EngineSheet.tsx`). Since AP-032 it shows even with one engine
  ([decision](../../decisions/20261120-one-engine-picker.md)). The rows are Claude Opus, Sonnet and Haiku
  (`server/src/admin/engines.ts:29-33`) and the Codex catalog models.
  - The choice is stored on the chat (`chats.model`). The person's own default lives in `users.prefs.model`
    (Settings › Profile "AI for new chats", `web/src/pages/Settings.tsx:545-600`). The team default is the
    `settings.defaultModel` key (Admin › Team settings › AI defaults).
  - Who may pick: `engines.memberChoice` (off | everyone | selected groups/people). The default is off, so only the
    owner and admins pick, and the server refuses anyone else's choice
    (`server/src/admin/engine-choice.ts:83-91`, DECISIONS "AI 엔진·모델은 관리자가 정한다").
- **The default on a subscription is Opus.** Nothing is chosen, so `SUBSCRIPTION_DEFAULT_MODEL = 'opus'`
  (`server/src/engine/claude.ts:118`, applied at `server/src/chat/turn.ts:1616`). The one exception is office Mac / dev
  local-login, which runs the CLI's own default.
- **There is no effort or thinking setting.** `--effort` is passed only as `low` for the find-work-files pick
  (`claude.ts:151-154,206`, `turn.ts:1640`). The flag is detected through `--help`. Codex has no
  `model_reasoning_effort`, and the API engine request has no reasoning field (`server/src/engine/api-agent.ts:256`).
  - Claude Code (docs fetched 2026-11-26, code.claude.com/docs/en/model-config): effort levels are low, medium, high,
    xhigh and max. Opus 5.5, Sonnet 5.5 and Haiku 5.5 default to `medium`. A level the model lacks falls to the next one
    down. It can also be set with `CLAUDE_CODE_EFFORT_LEVEL`.
- **Usage per model is shown, but the data behind it is wrong.**
  - Settings › Usage (`server/src/admin/my-usage.ts`, `MyUsage.tsx`) and Admin › Usage (`admin/budgets.ts:309-348`,
    group by model) already group by `turns.model`.
  - That column is written once, when the turn is created, with the *chosen* model. It is NULL when nobody chose,
    which is most turns, so most usage shows as "Default model". The Opus default, the refusal retry's model switch and
    a CLI substitution never update it.
  - The real model exists in three places and is dropped in all three:
    - The model proxy sees it on every request (`server/src/proxy/model-proxy.ts:430,553`). It passes it to
      `broker.record` (`server/src/credentials/broker.ts:165`) only for pricing.
    - Claude Code's `result.modelUsage` gives tokens per model (`server/src/engine/claude-parse.ts:196-204`), but its
      keys are dropped.
    - Codex reports tokens with no model. The Codex proxy path knows the model (`server/src/proxy/codex-path.ts:102`).
- **Limits.** Only a *refused* subscription limit is kept: its reset time and whether it is a week or longer
  (`claude-parse.ts:116-120`, `engine_credentials.limited_until`). We never know how full the 5-hour or weekly window
  is. `engines.limitFallback` can move a turn to the other engine when a limit is hit.
- **Shared and project chats.** The chat's model applies, and the turn runs on the *sender's* own connection
  (`routes/chats.ts:227,884`, `credentials/resolve.ts`).
- **Scheduled runs.** A run uses the schedule owner's current default at run time, on the owner's connection
  (`server/src/chat/schedules.ts:559-560`). A run that posts into a shared chat ignores that chat's model (`:591`).

## What the others do (checked 2026-11-26 on their help pages)

| Product | Where you choose | Effort | Admin | Usage per model |
|---|---|---|---|---|
| ChatGPT | Picker in the composer; Free says "Instant / Think", paid shows model names | Thinking level (Medium … Pro) | Business/Enterprise: models per role, workspace default | Message caps per plan |
| claude.ai | One menu by Send: model + effort + thinking, the last choice carries over | Low … Max | Enterprise: models on or off per role, a cap on effort per model, org default, "always start with the default" | Settings › Usage bars; Fable has its own weekly share |
| Claude Code | `/model`, `/effort`, settings `model`, `effortLevel` | Yes | Managed `availableModels`, `maxEffortLevel` | `/usage` with "Usage by model" |
| Cursor | Picker in the chat, Auto | none | Enterprise: models on or off, default | Usage rows name the model |
| Gemini | Picker in the input box | Low/Medium/High | App on or off only | Usage limits page |
| Slack AI | No choice | none | Features on or off | none |
| Codex CLI | `/model`, config `model` | `model_reasoning_effort`, `/reasoning` | No allowlist | `/status` |

Every chat product puts the choice in the composer and remembers it. Every admin-grade plan adds a team default and an
allowed list. None makes people go to Settings before each chat.

## Recommendation on the owner's question

**Both, on the one picker we already have. No new "Advanced" page.**

1. **The composer picker gets a second line: how hard it thinks.** It works like claude.ai's single menu:
   - Under the model rows comes one row with three choices: **빠르게 · 보통 · 꼼꼼하게** (en "Quick · Normal ·
     Thorough").
   - The choice is kept for the chat and starts the next new chat, the way the model already does.
   - The picker button shows it only when it is not Normal ("Claude Opus · 꼼꼼하게").
   - Nothing new is added to the composer. The button that is there now opens one menu.
2. **Settings keeps the person's default in the row that is already there.** Settings › Profile "AI for new chats" gets
   the same depth choice next to the model. No "Advanced" section: it would be a second place to find one setting,
   and the owner prefers fewer places (owner-prefers-lean-ui).
3. **Names:**
   - Models keep their real names: Claude Opus / Sonnet / Haiku, and the Codex catalog names. They already ship this
     way, claude.ai and ChatGPT show them, and people read them in news and in Claude's own usage page. Under each
     model, one plain line says what it is for: Opus "가장 똑똑해요, 한도를 빨리 써요", Sonnet "빠르고 대부분 충분해요",
     Haiku "가장 빨라요, 간단한 일".
   - Depth uses plain words, not low/medium/high/xhigh/max. Non-developers do not need five levels, and the plain
     words map cleanly onto both engines:
     - 빠르게 = `low`
     - 보통 = no flag (the model's own default, `medium` on the 5.5 models)
     - 꼼꼼하게 = `high`
   - `xhigh`, `max` and Claude Code's "auto" are not offered. They burn limits and claude.ai keeps them behind its
     own menu. They can be added later as a fourth word if people ask.

Why not a separate "Advanced" page: competitors put the choice where the message is written, our picker already exists
there, and a second page doubles what people have to learn.

## Admin controls and team defaults

These live in Admin › Team settings › AI defaults, on existing rows. Nothing new goes in the menu.

- **Team default:** model (exists) plus depth (new). Default: Opus + 보통, which is what runs today.
- **Who may choose (exists):** `engines.memberChoice`, off / everyone / selected. The depth choice follows the same
  rule, so one rule covers both. See decision 1.
- **Who may use the strongest model (new, one row):** "Opus는 누가 쓸 수 있나요": 모두 / 고른 사람·그룹 /
  관리자만.
  - It reuses the `MemberEngineChoice` shape (`{mode, groupIds, userIds}`) as the settings key
    `engines.strongModelWho`.
  - It applies to the Claude Opus alias and, for Codex, the catalog's first (top) model.
  - A person outside the rule does not see the row disabled. They do not see it at all, and their turns run on the
    team default with Opus replaced by Sonnet.
  - A per-person override is "selected people", the same as `memberChoice`. No per-person table.
- **Depth cap:** none in the first version. 꼼꼼하게 is `high`, not `max`, so the cap that matters is the model.
- **Server enforces all of it** in `engine-choice.ts` (one place), the way `memberChoice` is enforced.
  - A request for a model the person may not use is refused with 403 `engine_choice_not_allowed`, as today.
  - A request without a choice, in a chat whose stored model they may not use, steps down instead of refusing, with a
    step line "Opus 대신 Sonnet으로 답했어요 (팀 설정)".

## Shared and project chats, scheduled runs

- **Shared and project chats:**
  - The chat's choice applies to everyone, as today. Anyone who may choose can change it, and the change is visible
    to all, like a Slack channel setting.
  - Each turn still runs on the sender's own connection. The sender's rules apply, so someone outside
    "strongest model" gets Sonnet in an Opus chat, with the step line.
  - The usage counts for the sender.
- **Scheduled runs:**
  - The schedule keeps using its owner's default at run time, on the owner's connection, with the team rules applied
    at run time. An admin who closes Opus affects tonight's runs too.
  - Fix the gap at `schedules.ts:591`: a run into a shared chat uses that chat's choice, like a person sending there.
  - The schedule editor gets no picker of its own in this version (lean).

## Codex and the API engine

- **Codex:**
  - Model: the catalog list, as today.
  - Depth: always `-c model_reasoning_effort="low|medium|high"` (보통 and nothing chosen = `medium`; review of #631),
    passed in `server/src/engine/codex.ts` next to `-c model=`.
  - Shown for every Codex model in this version (the per-model `supported_reasoning_levels` filter is left for later).
  - The words are the same as for Claude.
- **API engine:**
  - It has one model per team (`engine-api.json`), so it still gets no model picker.
  - Depth is the last step and stays small (api-engine-scope-claude-code-first). It sends OpenRouter's
    `reasoning: { effort }` or OpenAI's `reasoning_effort` only for the presets known to take it. Otherwise the depth
    row is hidden for that engine.
  - The Claude Code path is unchanged by this step, and a test proves it.
- **Office Mac / dev local-login:** the same picker works. `--model` and `--effort` are plain CLI flags on the Mac's own
  login.

## Usage by model

- **Record the real model:**
  - New table `turn_models(turn_id, model, requests, input_tokens, output_tokens, cost_usd, est_cost_usd)`, one row
    per turn and model.
  - It is written by `broker.record`, which already has the model and the usage, from the proxy path.
  - When a turn has no proxy (local-login, company key), it is written from the engine's own report: Claude Code
    `result.modelUsage` keys, and for Codex the turn's model.
  - `turns.model` becomes the model that answered (set at launch and corrected from the first proxied request). The
    new `turns.effort` column holds the depth word.
  - Old rows stay as they are ("Default model").
- **Model names people read:** the dated ids (`claude-opus-5-5-…`) are shown as "Claude Opus" through one small
  name map in `shared/`. The admin CSV keeps the real id.
- **Settings › Usage (each person):** the existing "by model" list reads `turn_models`. Each row has the model name, a
  bar for its share of this period and the estimate ("API 가격으로 추정"). There is no new section.
- **Admin › Usage:** the existing "group by model" reads `turn_models`. Admin › Usage by person gets a model split
  (person × model) in the table and the CSV. Budgets stay in money and tokens, unchanged.
- **Limit notices:**
  - When a subscription limit is refused on Opus, the error card offers one button, "Sonnet으로 계속", next to the
    reset time. That is a model step-down on the same connection, not a switch of engine.
  - Read Claude Code's `rate_limit_event` with status `allowed_warning` as well. If the pinned CLI reports
    utilization, Settings › Usage shows "이번 주 한도 거의 다 썼어요". Verify it on 2.1.305 first; if the field is not
    there, drop this bullet.

## Data and migration

- B's range: the highest on dev is **454** (`454_b_often_asked_locale.sql`), so this is
  `455_b_model_effort.sql`. Check again right before merging (`MIGRATIONS_BASE=origin/dev bun run
  check:migrations`). Additive only, reader 1:
  - `ALTER TABLE chats ADD COLUMN effort TEXT` (NULL = 보통)
  - `ALTER TABLE turns ADD COLUMN effort TEXT`
  - `CREATE TABLE turn_models (… PRIMARY KEY (turn_id, model), turn_id REFERENCES turns(id) ON DELETE CASCADE)`, plus
    an index on `turn_id`
- No migration for these: `users.prefs.effort` (JSON), and the settings keys `defaultEffort` and
  `engines.strongModelWho` (key/value table).
- API, all optional fields:
  - `effort?: 'quick'|'normal'|'thorough'` on send, edit, regenerate and new chat
  - `defaultEffort` and `strongModelWho` on `GET/PATCH /api/admin/engines`
  - `effort` per engine model in `GET /api/engines` (which depths that model takes)
  - `byModel` rows in `/api/me/usage` and `/api/admin/usage` keep their shape
  - Run `bun run docs:api`.

## Steps

1. `feat/model-effort-record` (server only, nothing visible changes):
   - the `455_b` migration
   - `turns.model` set to the real model
   - `turn_models` written from the proxy and from engine reports
   - the usage queries read it
   - the display-name map
2. `feat/model-effort-choice` (server + web):
   - effort plumbing (`--effort`, Codex `model_reasoning_effort`)
   - the depth row in `EngineMenu`/`EngineSheet` and in Settings "AI for new chats"
   - team default depth
   - `engines.strongModelWho` with the step-down line
   - the shared-chat schedule fix
   - i18n in all six files (en source)
3. `feat/model-effort-usage` (web): the usage lists with names and bars, the person × model view in Admin, and the
   "Sonnet으로 계속" button on the Opus limit card.
4. (later, small) `feat/api-engine-effort`: depth for the API presets that take it.
5. Docs: `docs/site` AI page, `changes/model-effort.md`, a decision file
   `docs/decisions/<date>-model-effort-choice.md`, and `docs/CONNECTIONS.md` only if the AI providers row changes
   (it should not).
6. Rollout:
   - Build steps 1–3 as separate PRs, then merge them to dev together in one `batch/` PR. Test on qa.trina.app with
     QA-Acme, on Claude sign-in, Codex sign-in and the API engine. Add QA sheet rows before the work starts.
   - Existing teams keep today's behaviour (Opus, no flag, `memberChoice` as set) until an admin changes something.
   - New teams take decision 1.

## Decisions for the owner (at most 3)

1. **Who sees the picker.** Today only the owner and admins can pick, because `memberChoice` defaults to off.
   Recommendation: new teams start with **everyone**, and existing teams stay as they are, with an admin able to turn
   it on in one row. The owner's question was about each person's own setting, and every competitor lets members pick.
2. **Names.** Recommendation: **real model names (Opus / Sonnet / Haiku, the Codex names) with a one-line plain hint,
   plus plain depth words 빠르게 · 보통 · 꼼꼼하게.** This avoids both five effort levels and model names hidden
   behind "Fast / Smart". People who compare with claude.ai see the same model names.
3. **Opus on a shared team connection.** Recommendation: **everyone may use Opus by default (as now), and admins can
   limit it to chosen people or groups.** Outside the rule a turn steps down to Sonnet with one line. Opus stays the
   default (today's behaviour, the Claude Code floor), and the admin has the brake when the shared subscription runs
   short.

## Risks

- **Subscription limits.** Opus and 꼼꼼하게 use the window faster, and on a team connection one person's choice uses
  everyone's limit.
  - Mitigations: the strongest-model rule, 꼼꼼하게 = `high` (never `max`), the one-tap Sonnet step-down at a limit,
    and the per-model usage so an admin can see who uses what.
  - We cannot show how full the window is unless the CLI reports it (step 3 checks this).
- **Terms.** Choosing a model or an effort is the unmodified `claude` binary's own `--model` and `--effort`, on each
  person's own sign-in. Nothing new is stored or routed. This changes nothing about the existing terms reading
  (anthropic-claude-code-terms).
- **A model the connection cannot use.**
  - Cases: a plan without Opus in Claude Code, a gateway without that id, a Codex catalog that differs per plan, or the
    CLI substituting a restricted model.
  - The picker lists only what the engine reports (`claudeModels`, the locked catalog). The real model comes from the
    proxy, so a substitution is recorded and shown as a step line, never hidden.
  - A refused model is retried once on Sonnet. That is the refusal retry that already exists, now also used for
    "model not available".
- **`--effort` on the pinned CLI.** It is detected through `--help`, so an older CLI simply runs without it, but the
  pinned 2.1.305 must be checked. The engine lockdown tests (`tests/engine/lockdown-claude.ts`) must pass with the new
  flag.
- **Sub-agents.** `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` keeps sub-agents on the turn's model, so Haiku stays Haiku. Check
  that effort carries over too, or say in the hint that it applies to the main answer.
- **Five app languages plus en, phone and desktop.** The depth row must fit the phone sheet (`EngineSheet`) without a
  second sheet.
- **Migration number clash** with another B branch: renumber before merging.

## Tests

- `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`,
  `MIGRATIONS_BASE=origin/dev bun run check:migrations`.
- Unit:
  - `tests/unit/engine-choice.test.ts`: depth follows `memberChoice`; the strongest-model rule refuses a pick, steps
    down a stored Opus chat, and applies to schedules.
  - Turn arguments: `--effort low|high` and no flag for 보통; Codex `model_reasoning_effort`; the Claude Code path is
    byte-identical when nothing is chosen.
  - `turn_models`: written from a proxied request; from `modelUsage` without the proxy; from a refusal retry across
    two models.
- Security: `tests/security/r5-engine-choice.test.ts`, extended so that a member outside the rule cannot set Opus,
  set the depth or change `strongModelWho`.
- Web: `web/test/unit/engine-picker.test.tsx` (the depth row); `web/test/e2e/engine-choice.spec.ts` (pick 꼼꼼하게,
  it is sent and remembered; the phone sheet); the usage list by model.
- Real engines on QA: one Claude sign-in turn per depth with the model read back from the proxy; one Codex turn with
  `high`.

## Result

Built as one PR (`feat/model-effort-choice`) with the MVP of "Review changes" above; the cut items are not built.

- Server: migration `456_b_model_effort.sql`; `turn_models` written by `credentials/broker.ts` (proxy) and
  `chat/turn-models.ts` (engine report, only while the proxy counted nothing); the depth through
  `admin/engine-choice.ts` (same rule as engine/model), `chat/runtime.ts` createTurn, `engine/claude.ts` `CLAUDE_EFFORT`,
  `engine/codex.ts` `CODEX_REASONING`; the schedule fix through createTurn's `engineFor`; a new team writes
  `engines.memberChoice` = everyone at setup; usage lists read `TURN_MODEL_ROWS` and name models with
  `shared/src/model-names.ts`.
- Web: the depth row and model hints in the picker, Settings and Admin defaults, model names in the usage lists, six
  locales.
- No docs/site page described the picker, so none changed; `docs/CONNECTIONS.md` is unchanged (no connection mode or
  surface changed: the hint only reads how the person's connection is paid).

