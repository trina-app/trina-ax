# The composer shows the model picker with one engine that has two or more models

- Date: 2026-11-20
- Status: accepted
- Supersedes: [Composer: no AI picker with only one engine](../DECISIONS.md#composer-no-ai-picker-with-only-one-engine-fixone-engine-no-picker-2026-11-12-the-owner-qa-tc-182)
- Branch: ap032-one-engine-picker (AI parity QA AP-032, sheet tab "AI parity 2026-11-19")

- **Ask:** the AI parity QA (Trina against claude.ai, Claude engine only) found that claude.ai lets a person pick the
  model, and Trina does not when the team has only one engine. The picker was hidden for one engine, also when that
  engine had two or more models (owner rule of 2026-11-12, QA TC-182).
- **Rule:** the composer shows the AI picker when two or more engines are switched on, or when the one engine has two
  or more models (`showsEnginePicker` in `web/src/components/chat/EngineMenu.tsx`).
  - With one engine the picker lists that engine's models only: no engine row and no "Default model" row (TC-182's
    complaint was 4 rows for 3 models). Until the person picks a model, no row is ticked and the button says "기본 AI".
  - One engine with one model (the API engine) has no picker: there is nothing to pick.
  - Who may pick does not change (`canChooseEngine`). "다른 모델로 다시 시도" under a failed answer does not change.
  - The phone app is the web app in a web view, so the phone sheet (`EngineSheet`) follows the same rule.
- **Why:** parity with claude.ai. The owner can keep the 2026-11-12 rule at review.
- **Tests:** `web/test/unit/engine-picker.test.tsx` (the rule; one engine with three models gives three rows),
  `web/test/e2e/engine-choice.spec.ts` (one engine, two models: the list, a pick is sent with the turn),
  `web/test/e2e/phone-home-centered.cases.ts` (the phone card keeps the picker with one engine).
- **Version impact:** patch (web UI only; no API, data or migration change).
