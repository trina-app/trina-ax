# Each AI step shows its key input and what came back, like Claude Code

- Date: 2026-11-24
- Status: accepted
- Supersedes: in [Plain words in errors, cards and steps](../DECISIONS.md), "a connection tool's step never shows the AI's arguments" (the step now shows one key input to the person whose turn it is)
- Branch: feat/step-details (the owner, 2026-11-24: "클로드는 각각 스텝에서 뭘하는지 조금 더 디테일하게 보여주지 않나?")

- **Ask:** a research chat showed about 50 rows of "Bright Data · Search Engine" with no query, address or result, and
  minus icons with no words. Claude Code shows each call's key input and a short result.
- **Key input** (`shared/src/step-key-input.ts` `stepKeyInput`): one argument, chosen by the last word of its name
  (query, q, search, keyword, prompt; then url, link, domain; then path, file, folder; then command; then name, title,
  subject, text), ties to the schema's required arguments, then the schema's order, then the call's. Without one, the
  first required string of the schema. A list shows its first and "+N". Never by tool or service name.
- **Never shown:** an argument whose name says secret (token, key, password, auth, cookie, session, signature …), a
  value that looks like a secret (`findSecrets`: removed, the words around it stay) or a random id (UUID, hex, base64,
  generated runs), an address's scheme, user, query and fragment (an id in its path is "…"), anything but http(s),
  ws(s) and ftp addresses. Text is cut to 60 characters on one line; a path keeps its end.
- **Where:** connection tools and `call_tool` (`<service> · <tool> · "<query>"`), `api_request` (the path without its
  query), and any tool without words of its own. Built-in tools keep their own lines. A card's question keeps the
  tool's words alone (`label(…, { bare: true })`): the card lists every value itself.
- **What came back** (`Step.outcome`): `count` only when the service's answer is JSON with one list (or one named like
  results / items / data …); `end` from the server's own reason (declined, no answer, skipped in a shared chat, not
  allowed, failed); a service's error answer's first line as the step's detail. Beside the line in words; a failed step
  the AI got past says "Didn't work" in place, not only in a tooltip.
- **Runs:** 3+ calls in a row of the same tool fold into one row (`<tool's words> · 12 calls · 2 didn't work`) that
  opens to each call's input, like Claude Code's grouped calls. While the answer runs, the last steps show one by one.
- **Everywhere:** the line and the outcome are written by the server at the one place every step comes from (chat/turn.ts
  tool_start, chat/tools.ts after the call), so private and project chats, scheduled runs, sub-tasks (a sub-agent's call
  patches its own step under its sub-task, `patchAgentStep`) and both engines (Claude Code, Codex's MCP calls) get it.
  The web step list is the one the desktop apps and the phone app show. Web searches keep their own lines: the query
  and the result count, as before (Codex's too, codex-search-step.ts).
- **Shared chats:** unchanged ([20261124-shared-chat-card-steps.md](20261124-shared-chat-card-steps.md)): everyone but
  the person whose turn it is gets the generic word for every connection step; `outcome` and `detail` are dropped for
  them, live and stored. Their steps still fold, by their line.
- **Tests:** `tests/unit/step-key-input.test.ts`, `tests/unit/i-wiring.test.ts`, `tests/unit/c-integrations-tools.test.ts`,
  `tests/security/shared-chat-waits-for.test.ts`, `web/test/unit/steps-outcome.test.tsx`.
- **Version impact:** patch.
