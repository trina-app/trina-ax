# The API engine sends a stable prompt: the time with the message, large tools on demand, cache marks

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (narrows [The history window fits the API model's own context](20261118-history-small-models.md)
  for models with room: their tool list is no longer sent whole)
- Branch: feat/api-engine-diet (QA TC-4822..4828; plan docs/AGENTS/plan/20261120-2120-api-engine-diet-ollama.md)

- **Ask:** a team on the API engine (its own key at OpenRouter, OpenAI or another provider) paid for the whole prompt on
  every tool round, and every new chat read it from zero. Measured on dev: 34,000 characters of instructions and
  150,000 of tools (57 tools; the intro deck alone 33,000), 70,200 tokens per round on Claude Sonnet, no cached token,
  about $0.43 for "What's in the shared folder?". The time line (`Now: … 21:15:55.153Z`) sat in the middle of the
  instructions, so no two chats shared more than the start.
- **Rule (API engine only):**
  - The time goes in a `<turn_context>` block in front of the person's message, to the minute
    (`chat/prompt.ts apiTimeContext`, `PromptInput.timeInMessage`). The instructions are the same for every chat of a
    person in a place; the history comes last.
  - 21 large or rarely needed tools are listed in the instructions ("## More tools", name and first sentence) instead of
    sent: decks and video, PDF and Office editing, zip, schedules, folder and project access changes, skill moves and
    files, saving a connector file (`engine/api-tools-defer.ts`). The model calls `load_tools` (answered in the API engine
    loop, never an MCP tool, no step the person sees) and the named tools are sent for the rest of the answer, after the
    others, as Claude Code loads deferred tools. Calling one by name without loading works too. A model whose whole list
    does not fit its share of the context keeps the small-model fitting of 20261118-history-small-models unchanged.
  - A Claude model on OpenRouter gets cache marks (`cache_control`): the fixed instructions, the last message, and the
    message that was last in the round before. Other providers cache a repeated start by themselves.
  - A public address waits 10 minutes for the first answer (`HEADERS_TIMEOUT_MS`, Claude Code's `API_TIMEOUT_MS`); an
    address on this computer or the local network keeps no limit.
- **Claude Code and Codex do not change:** their instructions and tools are pinned byte for byte by
  `tests/unit/engine-prompt-pin.test.ts` (recorded on dev before this change; only the clock is replaced).
- **Measured** (QA copy of QA-Acme, OpenRouter `anthropic/claude-sonnet-5.5`, the same five member questions before and
  after): first-round prompt 70,206 → 36,184 tokens; cached tokens 0 → 99% of the prompt from the second question on;
  cost $2.14 → $0.17 for the five (the first question $0.11 with the cache write, then $0.015-0.018 each); time to first
  token 1.1-2.6 s → 0.9-2.2 s; every answer right before and after. A zip and a schedule question loaded their tools and
  answered.
- **Left out:** the rules text is not shortened; small local models get no new design (TC-4828 stays a small-model
  limit); the Claude Code path keeps its own time line.
- **Tests:** `tests/unit/api-engine-stable-prompt.test.ts`, `tests/unit/engine-prompt-pin.test.ts`, the API engine and
  small-model suites.
- **Version impact:** patch (cheaper requests and fixes; no setting, API or data change).
