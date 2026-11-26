# Everyone in a new team picks the AI model and how hard it thinks; usage shows the model that answered

- Date: 2026-11-26
- Status: accepted
- Supersedes: [AI 엔진·모델은 관리자가 정한다](../DECISIONS.md#ai-엔진모델은-관리자가-정한다-featadmin-engine-choice-2026-10-21) (for teams set up from this version on; the rest of it stays)
- Branch: feat/model-effort-choice (the owner, 2026-11-26; plan [20261126-0420-model-effort-choice](../AGENTS/plan/20261126-0420-model-effort-choice.md))

- **Ask:** the owner wanted a place to switch between Sonnet and Opus and set the effort, like ChatGPT and claude.ai,
  and each person's usage per model: "advanced 같은 설정 만들어서 거기서 sonnet, effort 같은거 바꿀 수 있게 … 각자가 얼마
  썼는지에서 모델 별로 나오긴 해야겠네".
- **Rule:**
  - **Who picks.** A team set up from this version on lets everyone pick (`engines.memberChoice` = everyone, written once
    when the owner account is made: `settleNewTeamMemberChoice`). A team from before keeps its setting; with no setting
    it stays "owner and admins only", and an admin turns it on in one row (Admin › AI providers). The depth follows the
    same rule as the engine and model; the server refuses anyone else's choice (403 `engine_choice_not_allowed`).
  - **Names.** Real model names (Claude Opus, Sonnet, Haiku and the Codex catalog's names), each with one plain hint
    line. On a subscription the hint talks about the limit ("가장 똑똑해요, 한도를 빨리 써요"), on an API key about cost.
  - **Depth.** Three words: 빠르게 · 보통 · 꼼꼼하게 (en Quick · Normal · Thorough), one row under the models in the
    composer's picker, kept for the chat and starting the next new chat. Settings › Profile "AI for new chats" holds the
    person's default, Admin › Team settings › AI defaults the team's.
    - Claude Code: `--effort low`, no flag, `--effort high` (the pinned 2.1.305 has it; the `--help` check stays).
    - Codex: `model_reasoning_effort` low / medium / high, always sent: 보통 and nothing chosen are `medium`, so a run
      matches the 보통 the picker shows (some Codex models default to low).
    - `xhigh`, `max` and "auto" are never offered: they burn the limits.
    - The API engine takes no depth in this version.
  - **Opus stays the default** on a subscription, as before. No Opus allowlist.
  - **Usage by model** reads the model that really answered (`turn_models`, migration 456), from the model proxy and,
    without one, from the engine's own report. The proxy's count replaces the engine's for a turn, never adds to it.
    `turns.model` stays the model asked for. Claude Code's own small background calls on Haiku are real usage and show
    as a Haiku row.
  - **Scheduled runs** take their owner's default depth; a run that posts into a shared chat answers with that chat's
    model and depth, as a person sending there would.
- **Why:** every chat product puts the choice in the composer and lets members pick; plain depth words map onto both
  engines without five levels; admins keep the brake ("who may pick") for a shared subscription.
- **Left out:** an Opus allowlist and a step-down to Sonnet, a "Sonnet으로 계속" button on the limit card, a "limit almost
  used" notice, the person × model admin bars, depth for the API engine.
- **Tests:** `tests/unit/b-model-effort.test.ts` (migration, recording precedence, no double counting, flags per
  engine, who may pick, new team), `tests/unit/b-shared-chat-schedules.test.ts` (the shared-chat run's model and depth),
  web unit and e2e for the picker row.
- **Version impact:** minor (a new visible choice; additive API fields and migration).
