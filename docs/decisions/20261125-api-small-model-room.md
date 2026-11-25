# A small API model gets no rules for tools it was not given, and its tools leave room for the newest messages

- Date: 2026-11-25
- Status: accepted
- Supersedes: none (adds to docs/decisions/20261118-history-small-models.md; the 35% tool share and the answer room stay)
- Branch: batch/20261125e (merge queue run 45610700146 of #579 + #582)

- **Ask:** #579 (HWP plugin hint) and #582 (figures from the web) each passed CI, but together they made the shared
  instructions about 350 tokens longer, and the small-model tests failed. With them, a 16k Ollama model (num_ctx) was
  refused as too small, and a 32k model got none of the conversation, not even the message before. The API engine was
  sending the rules for every tool in the set, also the tools left out for that model (web_fetch, make_file, …). The
  tool list also took its full share before the history got anything, so every new rule came out of the history.
- **Rule:**
  1. On the API engine, when the tool list is fitted to a small model and tools are left out, the instructions are built
     without those tools (chat/turn.ts `apiLeftOut`). Their rules are not sent; the left-out note still names them.
  2. The tool budget keeps `HISTORY_ROOM_MIN` (2,048 estimated tokens) free for the newest messages
     (chat/history-fit.ts `toolBudgetFor`). The file tools are always sent, as before.
- **Why:** a rule for a tool the model cannot call costs tokens and does nothing. A chat that forgets the previous
  message is broken. This fixes the whole class (any rule added later) and not one number in a test.
- **Left out:** shorter wording of the shared rules. They are the Claude Code and Codex instructions too, and those
  paths do not change (engine prompt pins unchanged by this fix).
- **Tests:** tests/unit/b-history-small-models.test.ts (16k: the left-out tool's rule is not sent; 32k: the newest
  message is kept; the tool budget with the history room).
- **Version impact:** patch (API engine on small local models only).
