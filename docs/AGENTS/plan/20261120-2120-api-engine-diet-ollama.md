# API engine: a stable, smaller prompt for hosted models behind an API key

- Date (UTC): 2026-11-20 21:20
- Branch: `feat/api-engine-diet` (plan first drafted on `plan/api-engine-diet-ollama`)
- Status: done
- Where: `server/src/engine/`, `server/src/chat/` (API engine branch only), `web/src/pages/admin/Engines.tsx`. Why: the
  API engine is part of the open server (docs/REPOSITORY-RULES.md).
- Version impact: patch. Bug fixes and cheaper requests on the API engine; no new setting, no API or data change.

## Goal

A team that runs its AI through an API key (OpenRouter, OpenAI, a large open model at a provider) pays for the whole
prompt on every tool round, and every new chat reads it again from zero. Make that prompt stable, so the provider's
prompt cache reuses it, and smaller, so each round costs less and starts sooner. Make long first answers wait as Claude
Code does. Fix three small settings problems that QA found with Ollama.

The Claude Code and Codex login paths, which most teams use, do not change at all: not their instructions, not their
tools, not their behaviour.

## Current state (measured on dev 4bc4e5c51, 2026-11-20)

One member question ("What's in the shared folder?") on the API engine, captured from the request the server sends to a
fake OpenAI-compatible server (unit harness, member and owner, a model that says it has 1M tokens):

| Part | Characters | Estimated tokens (server's estimator) | What it is for |
|---|---:|---:|---|
| System text (rules, person, app map, team rules, services) | 34,083 (owner 36,264) | 8,549 | every answer: how to use files, sharing, rooms, cards, wording |
| of which the main rules block | 26,441 | 6,618 | per-tool rules (PDF, share, rooms, ask_user …), only for tools offered |
| Tool definitions (57 tools) | 150,694 | 37,674 | the function list sent with every round |
| of which schema argument texts | 106,971 | | the descriptions inside `parameters` |
| of which `intro_deck` alone | 32,794 | | one tool: 22% of the list |
| Top 5 tools (intro_deck, promo_video, edit_pdf, edit_office, make_file) | 66,869 | | 44% of the list |
| Skills list | 0 in the harness; at most 8,000 (`SKILL_LIST_BUDGET`) | ≤2,000 | names and one line per skill |
| File list | one rule line (about 640) | 160 | `_FILES.md` contents are read with tools, never put in the prompt |
| Whole request body | 192,483 | about 46,000 | |

With the tokenizer of a real model the same request is about 37,000 tokens (QA TC-4823 counted 29,068 Ollama tokens for
the 152,914-byte request of 11-18; 192,483 bytes at that ratio). The request goes again on every tool round:
QA's OpenRouter runs on 11-18 used 75k-330k input tokens per task (about 165k on average).

**The cache break (TC-4824, still open).** Two new chats of the same person differ first at character 25,581 of the
system text: `Now: … 2026-11-20T21:15:55.153Z UTC` carries milliseconds and sits in the middle of the instructions. On a
provider that puts the tools after the system text (Qwen's template on Ollama, measured on 11-18: 5,086 of 29,068 tokens
reused), everything after that point is read again on every new chat. Inside one answer the system text stays the
same from round to round, so the loss is per answer and per chat, not per round.

**The 90 s cut (TC-4822).** Already fixed for local and private addresses (`isPatientApiAddress`). A public address
still fails after 90 s without response headers (`HEADERS_TIMEOUT_MS`). Claude Code waits 10 minutes for the API
(`API_TIMEOUT_MS` default 600,000).

**What already shrinks.** On a model with a small context (`engine/api-tools-fit.ts`, decision 20261118-history-small-models)
descriptions are cut and large tools left out: 41,716 characters at 32k. A large hosted model gets the whole list.

## Scope

In (API engine only):

1. **Stable prefix.** The time line leaves the system text on the API engine and goes, to the minute, in a
   `<turn_context>` block in front of the person's message (the rules already say what that block is). The system text
   and the tool list are then byte-identical for every chat of the same person and place.
2. **Cache markers for Claude models on OpenRouter.** OpenRouter caches Anthropic models only where the request marks
   it (`cache_control` on a content part); OpenAI, DeepSeek, Gemini and Grok cache by themselves. A request to an
   `anthropic/*` model on openrouter.ai marks the end of the system text, so tools and instructions are cached together.
3. **Tools on demand.** 21 large or rarely needed tools are not sent as functions on the API engine: intro_deck,
   promo_video, save_promo_video, edit_pdf, stamp_pdf, merge_pdfs, split_pdf, edit_office, comment_docx,
   resize_images, unzip_file, make_zip, schedule_create, schedule_list, schedule_delete, change_folder_access,
   change_project_members, share_folder, move_skill, skill_files, save_connector_file. The instructions list them by name
   with their first sentence (about 3,000 characters), and a local `load_tools` function (answered in the API engine
   loop, never an MCP tool) adds the named ones to the list for the rest of the answer, as Claude Code's tool search
   does for deferred tools. A call to a listed tool by name works without loading it first (the handler checks it
   as always). The rules in the system text stay as they are. Measured: tools 150,694 → 59,774 + 3,041 characters (-58%).
4. **Long first answers.** On a public address the wait for the first response is 10 minutes, as Claude Code's API
   timeout; local addresses keep no limit. The turn's stall guard (15 minutes) stays.
5. **Ollama and settings fixes (small).**
   - TC-4825: an admin does not get the Ollama preset as a normal choice; it says the owner sets local addresses.
   - TC-4826: switching to a preset that needs no key, with a new address, removes the old key in the same save.
   - TC-4827: a refused connection to a local address says that nothing answers there and, for Ollama, to start it.

Out: any change to Claude Code or Codex (their prompt keeps its time line); shortening the rules text; a search tool
or rules for small local models (TC-4828); a tool-calling test call in the admin check; reading Ollama's pulled models.

## How the Claude Code path is kept unchanged

- Every change is behind the API engine: a new `PromptInput.timeInMessage` field (default off) that only the API branch
  of `chat/turn.ts` sets; the tool split and `load_tools` live in `engine/api-agent.ts` / a new
  `engine/api-tools-defer.ts`, after the MCP `tools/list`, so the gate's list for Claude Code and Codex is the same.
- A pin test (`tests/unit/engine-prompt-pin.test.ts`), committed before any change and recorded from unchanged dev:
  a member and an owner turn on the fake Claude Code engine and the fake Codex engine echo their system prompt and
  their full tool list (names, descriptions, schemas); the test compares them byte for byte with the recorded files
  (only the clock in the time line is replaced by a fixed value).

## Steps

1. Pin test and its recorded files on unchanged code (commit 2).
2. Time line out of the API system text, to the minute, in the message; unit test that two chats send the same prefix.
3. `cache_control` for `anthropic/*` on OpenRouter; unit test of the request body.
4. `api-tools-defer.ts` + `load_tools` in the loop; the history fit counts the list as sent; unit tests (list sent,
   load, direct call of a listed tool, tools re-listed after a connection keep what was loaded, small-model fit after it).
5. Headers wait 10 minutes on public addresses; unit test with a fake clock.
6. The three settings fixes, with messages in all app languages; unit tests; web check at 1440 and 390.
7. QA on a new private copy of the QA team: a mock OpenAI-compatible endpoint first, then OpenRouter with a
   Sonnet-class model, before and after, same questions (TC-4822..4828 flows, find a file by meaning, read a doc, write a
   short doc). Per run: prompt tokens, cached tokens, time to first token, total time, cost (OpenRouter usage), right or
   not. Spend under $10.

## Decisions

`docs/decisions/20261120-api-engine-stable-prompt.md`: the API engine's time line goes with the message, heavy tools
come on demand, Claude Code and Codex keep their prompt (pinned).

## Risks

- A model may not load a tool it needs. Mitigation: the list names every tool with its first sentence, a direct call
  works, and QA asks for a deck and a PDF edit on the API engine.
- No migration. No change to the five app languages beyond three new settings messages. Desktop and phone unchanged.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run check:prepush`, the API engine unit tests
(`tests/unit/api-engine-*`, `b-history-small-models`, `limits-api-images-cards`), the new pin test, and the admin
engines tests.

## Open questions for the owner

1. **Which tools come on demand?** Recommendation: the 21 above (decks, video, PDF and Office editing, zip, schedules,
   folder and project access changes, skill moves). The smaller choice, only the 5 largest, saves 44% instead of 58%.
2. **Same cache fix for Claude Code later?** Its fresh sessions have the same millisecond line. Recommendation: no change
   now (the login path stays as it is); look again only if teams hit Claude usage limits.
3. **Budget for a full quality pass on the API engine** (`tests/ai-scenarios` with an API-engine option, about 100
   cases before and after). Recommendation: yes, capped at $10, on a large open model at OpenRouter, with 20 cases on a
   Sonnet-class model.

## Result

Built as planned on `feat/api-engine-diet`. Differences: a model whose whole list does not fit its share of the context
keeps the small-model fitting (no tools on demand there), so 20261118-history-small-models behaves as before; the
blind-guess check still compares with the whole list. Measured before and after on OpenRouter Claude Sonnet 5.5 (five
member questions): first-round prompt 70,206 → 36,184 tokens, cached 0 → 99% from the second question, cost $2.14 →
$0.17, all answers right. Details in docs/decisions/20261120-api-engine-stable-prompt.md.
