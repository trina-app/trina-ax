# The AI's thinking text is kept on its "Thinking" step, closed until the person opens it

- Date: 2026-11-20
- Status: accepted
- Supersedes: none
- Branch: ap033-thinking-text (AI parity QA 2026-11-19, row AP-033: "claude.ai shows the model's thinking text;
  Trina drops it")

Plan: [docs/AGENTS/plan/20261120-0250-ap033-thinking-text.md](../AGENTS/plan/20261120-0250-ap033-thinking-text.md).

- **Ask:** claude.ai shows what the model thought before it answered. Trina showed a "Thinking" step with no text:
  `server/src/chat/turn.ts` made the step from the engine's `thinking` events and dropped their text.
- **Rule:** the turn keeps the text of each thinking step as the engine sends it (Claude Code's `thinking_delta`, Codex's
  `reasoning` item). When the step closes (`closeThinking`: the next text or tool call, or the end of the engine run),
  the whole text goes on the step once, as `Step.detail`, through `updateStep`. So it is saved with the message and a
  reload shows it. The web app shows a thinking step with text as a row that is closed by default and opens on click
  (`web/src/components/chat/Steps.tsx`); a thinking step without text (an older answer, an empty block) stays a plain
  row.
- **Privacy:**
  - The stored connection secrets are hidden in the whole text (`redactStep`, `server/src/integrations/connections/
    redact.ts`), the same redactor as the answer text. The text is redacted whole, never piece by piece: a secret cut
    across two deltas still matches. The step's 4000-character cap applies after the redaction.
  - Who sees it: the people who see the step detail now. In a chat that only its person sees, that person. In a shared
    chat, only the person whose turn it was (`ChatStore.viewSteps` drops `detail` for the others, and for answers from
    before the chat was shared). Thinking can quote a file the other members cannot open, so we keep it with the
    runner, like a step's other details.
  - A sub-agent's thinking stays dropped (docs/DECISIONS.md "Sub-agents"). The history summary and the context recovery
    block skip thinking steps, as before: the text never goes back to the model.
- **Why one write per step:** each step write is published to the person and, in a shared chat, run through
  `viewSteps` for every other viewer. One write per delta would send the growing text again and again. The step shows
  "Thinking" with a spinner while it runs, and its text when it ends.
- **Left out:**
  - A per-message "extended thinking" toggle and any change to the thinking budget. We show only what the engine returns
    now. The toggle is a separate owner decision (cost, latency).
  - Thinking longer than 4000 characters is cut (the step detail's cap). A larger cap for thinking needs a schema change.
  - The phone app has no step view, so it shows no thinking text.
- **Tests:** `tests/unit/c-integrations-secret-echo.test.ts` "AP-033" (the text on the step, a stored key hidden, the
  same after a reload, an empty block adds no text; fake engine `@fake {"think": "…"}`);
  `web/test/unit/steps-thinking-text.test.tsx` (closed by default, opens and closes on click).
- **Version impact:** minor (a new visible feature; no API break, no migration).
