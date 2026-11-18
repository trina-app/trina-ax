# The API engine's answer says what really happened

- Date: 2026-11-18
- Status: accepted
- Supersedes: none. Adds to the API engine entries of the archive (QA B-API-1, B-API-2)
- Branch: fix/api-engine-honest (the owner, QA TC-4829, TC-4830, TC-4831, TC-4832)

- **Ask:** open models through an OpenAI-compatible provider (gpt-oss-120b and others) overwrote a quote file with a
  near-empty body and answered "고쳤어요"; put "확인해 볼게요…" lines in front of the answer; wrote links with no address;
  and a provider's own 429 showed as "AI usage limit reached", which people read as the team's limit.
- **Rule 1, a save that wipes a file** (`server/src/engine/api-honest.ts` `ReadLog`, API engine only): a `write` that
  would replace a file the AI read in this answer with less than 30% of the bytes it read is refused before the tool
  runs, and the file is not touched. Files under 400 bytes are never guarded. The size comes from the read's numbered
  lines; a partial read gives a smaller size, so the rule can only refuse less. A later save of that file records the
  new size; a file the AI only wrote itself is never guarded (condensing its own draft is fine); any other call that
  worked and names the file (`edit`, `edit_files`, rename, move, delete …) forgets it. The refusal goes back to the model as the tool's error and
  tells it to use `edit`, or, when the person asked for the whole file to be emptied or replaced, to call `write` again
  with `confirmed_by_user: true`; the engine takes that argument out before the call (the write tool's own input is
  strict and unchanged). This keeps "empty this file" possible in one answer without asking twice. A model can claim
  the confirmation falsely; then the save runs as it does on the other engines, and the file's earlier version is kept
  as for every overwrite.
- **Rule 2, a failed step the answer does not mention** (`FailedSteps`, `failedStepsNote`): a tool call that failed
  (error result, bad arguments, a refusal, rule 1) and was not done again with success afterwards (same tool and
  target; `write` and `edit` of the same file count as one step, and making or changing a file settles a read of it
  that failed, e.g. "not found" before it was created) adds one line at the end of the answer, in the
  person's language (`server/src/chat/i18n.ts` `apiStepFailed` / `apiStepsFailed`): "One step didn't work: Save." The
  step names are the server's step words (`shared/src/step-labels.ts` `stepWords`; "Step" for a tool without words of
  its own, so a made-up or connection tool name never shows). No path, argument or model text is ever in the line. The
  line is left out when the answer already says something failed (a short list of phrases per language: failed to,
  couldn't save, 실패했, 못 했, できませんでした, 失败了, no se pudo, gagal …). A bare word for "error" never counts: "오류를
  고쳤어요" or "I fixed an error" is what a model says after a save that failed. Not added on
  Stop, budget stops or provider errors (the error itself is shown); added at the round limit.
- **Rule 3, narration is not the answer** (`server/src/engine/api-agent.ts`): text of a round that also calls tools is
  not shown (the model still gets it back in the conversation). The answer is the final round's text; when that is
  empty, the last non-empty text the model wrote. A round cut by an error or Stop shows what it wrote unless it was
  asking for a tool; a round cut at the output limit shows its text (its cut tool call never runs). The cost: the API
  engine's answer appears when its round ends instead of streaming word by word, since only the end of a round says
  whether it called a tool. A Stop or a budget stop between rounds shows no text from the earlier tool rounds (it was
  narration); the steps and the stop's own message stay.
- **Rule 4, empty links**: `[label]()` and `[label]( )` (and the image form) become `label` in the answer, outside fenced
  code blocks and inline code. Real links are left to the link guard (`engine/api-links.ts`) as before.
- **Rule 5, a busy provider**: a provider 429 (HTTP status or inside the stream) is the engine error `provider_busy`
  with its own words ("The AI service is too busy right now. Try again shortly, or pick another model.", 6 languages,
  `shared/src/api/errors.ts`, code `rate_limited`). `rate_limit` stays for our own limits (the model proxy, the
  subscription limit) and the Claude/Codex paths.
- **Left out:** the 90 s header timeout, prompt size, prompt caching and the Ollama preset (TC-4822..4828, a separate
  plan); the same guard for the Claude Code and Codex engines (their file tools go through the gate; no report there).
- **Tests:** `tests/unit/api-engine-honest.test.ts` (each rule, with fake upstream answers), `tests/unit/api-engine.test.ts`
  updated for held narration, the 429 reason and the line after a refused read.
- **Version impact:** patch.
