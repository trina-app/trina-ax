# An Ollama or LM Studio model not loaded yet: its default context, and a cut tool list

- Date: 2026-11-19
- Status: accepted
- Supersedes: the "a guess never cuts the tool list" and "an unloaded model is a 32,000 guess" parts of
  20261118-history-small-models.md
- Branch: fix/ollama-unloaded-context (QA TC-5087)

- **Ask:** on a 16k Ollama server whose model was not loaded yet, the API engine used the 32,000 guess and, after the
  security review of #1322, sent the whole tool list on a guess. Prompts were 36k-48k tokens against 16,386; Ollama cut
  their start for about 10 minutes (the guess was cached that long) and the memories were lost.
- **Rule:**
  - Ollama, model not loaded: `num_ctx` from `/api/show` is exact (Ollama uses it when it loads the model). Without it
    the look-up loads the model (an empty `/api/generate` with `keep_alive` 5m, within the look-up's 5 s) and reads
    the size it loaded with from `/api/ps`, so a server with a large `OLLAMA_CONTEXT_LENGTH` is not taken for a 4096
    one. A load that does not finish in time leaves the guess: the server's default, which no API shows, 4096 when
    `OLLAMA_CONTEXT_LENGTH` is not set (2048 before 0.6, read from `/api/version`), at most the trained length
    (`model_info` `<arch>.context_length`). LM Studio, model not loaded: its default load size, 4096, at most
    `max_context_length`.
  - A guess is cached one minute, not ten: once the first request loaded the model, `/api/ps` says the real size.
  - Ollama's and LM Studio's own guess (a model not loaded yet) cuts the tool list like an exact size. Every other
    guess is blind (`blindGuess`): a cloud address, or a local address that is neither, such as a LiteLLM proxy at
    `http://litellm:4000` in front of a 200k model. A blind guess keeps the whole list and is ignored when the tools
    alone fill it.
  - The tool budget is 35% of the context, but never more than the instructions, the message and the answer room
    leave (`toolBudgetFor`): on 16k about 5,000 estimated tokens. With 35% alone, the instructions and the tools
    filled a 16k model and the turn ended with `model_too_small`.
  - A guess still never refuses a turn: a model the 4096 default really holds gets the file tools and no history,
    which Ollama may still cut; the next turn after it is loaded fits the real size.
- **Why:** the first request after a model loads is the common case (Ollama unloads idle models after 5 minutes), and
  a silent cut of the instructions is the failure #1322 was made to stop.
- **Left out:** a load longer than 5 s (a large model from a slow disk) falls back to the guess; the next turn after
  it finished reads the real size (a guess is cached one minute).
- **Tests:** `tests/unit/b-history-small-models.test.ts`: unloaded Ollama with and without `num_ctx`, before 0.6, a
  model trained for less, unloaded LM Studio, the one-minute guess cache, `cloudGuess`, `toolBudgetFor`, and end to
  end: an unloaded 16k model with `num_ctx` keeps the memory in a request that fits; one without `num_ctx` gets the
  file tools, a note naming the tools left out and no history, and no refusal; a local address that says nothing
  (a LiteLLM proxy, 32k guess) keeps the whole tool list and the default window; the look-up loads an unloaded model
  and reads its real size, and a load that takes longer than 5 s leaves the default guess.
