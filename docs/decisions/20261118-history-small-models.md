# The history window fits the API model's own context

- Date: 2026-11-18
- Status: accepted
- Supersedes: none (narrows "A fresh session gets a summary of the older part of the chat",
  20261118-limits-context-summary.md, for the API engine on a model with a small context)
- Branch: fix/history-small-models (limits audit, QA TC-4940)

- **Ask:** the history a fresh session gets was 40,000 estimated tokens for every engine, made for Claude Code
  (200k) and Codex (272k). The API engine on a local model (Ollama, LM Studio, llama.cpp, vLLM) often has 4k-32k
  tokens. The history alone was more than the model could read: the provider refused ("This conversation got too
  long. Please continue in a new chat"), or Ollama cut the start of the prompt without a word, and the start is the
  instructions. Measured on the test server: the instructions are about 8,000 estimated tokens and a member's full
  tool list about 33,000 (130,000 characters; the intro deck tool alone 35,000), so a 32k model could not read even
  one message with them.
- **Rule:**
  - The context size is learned from the model's own server, never typed in (`server/src/engine/api-context.ts`):
    Ollama `/api/ps` (the loaded size) then the `num_ctx` parameter of `/api/show`; LM Studio
    `/api/v0/models/<model>` (`loaded_context_length`); llama.cpp `/props` (`n_ctx`, local addresses only); any
    OpenAI-compatible `/models` list (`max_model_len` vLLM, `context_length` OpenRouter / Together, `context_window`
    Groq …). A refusal that names a size ("maximum context length is 8192 tokens", "context length of only 4096
    tokens", `n_ctx`) is kept for an hour and wins when smaller. Probes are cached 10 minutes (1 minute when nothing
    was learned), take at most 3 s each and go through the same address check as the turns (`apiEngineFetch`). The
    key goes only to the `/models` address it was saved for, never to `/api/*` or `/props` of that host.
  - Exact and guessed sizes: a size the model runs with now is exact. A local address that says nothing, an Ollama
    model not loaded yet (trained length, capped) and an LM Studio model not loaded are a guess of at most 32,000 (as
    #1284's prompt budget assumes for a local address). A guess only shrinks the window; it never refuses a turn. A
    cloud model that says nothing keeps the default window.
  - The window (`server/src/chat/history-fit.ts historyFit`): the context minus room for the answer and the turn's
    work (a fifth of the context, at least 2,048), minus the instructions without the history, the tool list as sent
    and the message (estimated, times 1.15 for JSON and code), at most HISTORY_MAX_TOKENS. `historyBlock`,
    `historyTrimmed`, `uncovered`, `summaryTarget` and `ensureSummary` take that budget.
  - Summary instead of cut: the summary path (#1283) now works on the smaller window, so what it leaves out is
    summarized. A summary larger than half the window is shortened to its beginning (goal and facts come first) with
    a note. With no room at all every message is left out and counted, none half-cut, and no summary is asked for.
  - The tool list on a small model (`server/src/engine/api-tools-fit.ts`): at most 35% of the context. Only as far as
    needed: descriptions cut to their first sentences (300 characters), then the descriptions inside the schemas left
    out, then the largest tools that are not file tools left out one by one. The instructions name the tools left out
    and tell the AI to say plainly that the team's model is too small for them, never that it was done. A model with
    room gets the list unchanged.
  - Telling the person: an answer whose history was cut only because of the model (the default window would have held
    it) shows "The AI model your team uses can read only a short conversation at once, so it remembers only the most
    recent part" instead of "This conversation is long" (`messages.history_small_model`, migration 420). A model whose
    exact size the instructions, tools and message alone overflow ends the turn before any request with the new error
    `model_too_small`: "The AI model your team uses can't read this much at once … Ask your admin to choose a model
    that can read more, or to give it a larger context length in Ollama or LM Studio." A provider refusal that names
    a size gets the same words instead of "continue in a new chat" (a new chat would not help), and the next turn
    fits the size it named.
- **Why:** Claude Code fits its work to the model's context and compacts with a summary; it never sends more than the
  model can read. Ollama's silent cut is the worst case: the answer ignores the team's rules and nobody knows why.
- **Left out:**
  - Claude Code and Codex are unchanged (their contexts hold the default window).
  - Tool results inside one answer are still up to 30,000 characters each (`TOOL_OUTPUT_MAX`); on a 32k model a few
    large reads can still overflow mid-answer. #1284 sizes the skill tool against that constant, so it is a separate
    change.
  - No admin field for the context size: every server named above says it. A team on a server that says nothing gets
    the guess, and the refusal's number after the first refusal.
  - The instructions themselves are not shortened for small models (#1284's prompt budget sizes rules and memories).
- **Tests:** `tests/unit/b-history-small-models.test.ts` (window with a budget, summary shortening, summary target,
  `historyFit`, every probe and refusal wording, the key only on `/models`, cache, and end to end on a fake Ollama:
  the request fits a 32k model with the note, a 1M model keeps everything, the summary path, a 4k model refused with
  no request, a refusal's size used by the next turn).
- **Version impact:** migration 420 adds one column (additive, readers from 1).
