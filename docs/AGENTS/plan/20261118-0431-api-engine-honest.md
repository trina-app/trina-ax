# The API engine's answer says what really happened

- Date (UTC): 2026-11-18 04:31
- Branch: `fix/api-engine-honest`
- Status: done
- Where: trina-ax `server/src/engine/`, `server/src/chat/` (i18n, turn), `shared/src/` (error words), `web/src/i18n/`. Why: the API engine and chat errors are core (docs/REPOSITORY-RULES.md)
- Version impact: patch, server bug fixes with no new setting or API

## Goal

QA TC-4829..4832, found with open models through an OpenAI-compatible provider. The answer of the API engine must not
claim work that failed, must not start with the model's "let me check" lines, must not show empty links, and a busy
provider must not read as our own usage limit.

## Scope

In:
- TC-4829: a `write` that would replace a file the AI read in this answer with less than 30% of its size (the file at
  least 400 bytes) is refused before it runs, the file untouched; the refusal tells the model to use `edit`, or to ask
  the person and repeat the write with `confirmed_by_user: true` only when the person asked for it. A tool step that
  failed and was not done again with success afterwards adds one server line at the end of the answer when the answer
  does not say that something failed ("One step didn't work: Save."). The step name comes from the server's step words.
- TC-4830: text of a round that also calls tools is held back; the answer is the last round's text, or the last
  non-empty text when the last round has none.
- TC-4831: `[label]()` and `[label]( )` become `label` outside code.
- TC-4832: a provider 429 becomes its own reason `provider_busy` with its own words in 6 languages.

Out: the 90 s header timeout, prompt size, prompt caching, the Ollama preset (TC-4822..4828).

## Steps

1. `server/src/engine/api-honest.ts`: the shrink rule, the read log, failed-step tracking, the "mentions a failure"
   check, empty links.
2. `api-agent.ts`: hold text per round, apply the rules, emit the server line; 429 -> `provider_busy`.
3. `shared/src/api/errors.ts`, `shared/src/engine.ts`, web i18n: the new reason. `server/src/chat/i18n.ts`: the line.
4. Unit tests with fake upstream answers; typecheck, i18n, docs, prepush.

## Decisions

docs/decisions/20261118-api-engine-honest.md

## Result

Built as planned in `server/src/engine/api-honest.ts` and `api-agent.ts`, tests in
`tests/unit/api-engine-honest.test.ts`. After the independent review: bare "error" words no longer count as the answer
saying a step failed, a failed read is settled by creating the file, the AI's own drafts and files it renamed, moved or
deleted are not guarded, and the singular/plural line follows the number of failed steps. The API engine's answer now
appears when its round ends instead of streaming.
