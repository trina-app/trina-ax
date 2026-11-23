# Fewer asks by removing what we added, measured against plain Claude Code

- Date: 2026-11-23
- Status: accepted
- Supersedes: the forms-folder line of [DECISIONS.md "team folder basics"](../DECISIONS.md) (the instructions no longer name the forms folder)
- Branch: fix/b5-asks-left (the owner: "general한 문제를 풀고있는게 맞지? case specific하게 가면 안된다", "똑같은 클로드 코드면 똑같이 똑똑해야겠지?")

- **Rule:** Trina runs the Claude Code engine, so an ask plain Claude Code would not make is first looked for in what we put around it. Delete or shorten our instructions before adding any. No rule for one phrase, one tool's wording or one QA flow. Guards on the floor (who gets something, whose content is shown) stay at the tool.
- **Measured:** same engine, model and files; nine ordinary held-out requests: Trina asked no more than plain Claude Code. The gap was a shared-chat share with the file only in the chat: 10 of 10 runs asked "which folder?".
- **Removed:** the system prompt line "Forms and templates are in <folder>/ … saving the new document in the user's own folder …". Without it 3 of 10 asked (one-sided Fisher p = 0.0016, rule fixed before the runs). A request that needs a template still found and used it (3 of 3, one request). Why this line causes it is not known.
- **Removed as written for one flow:** a phrase rule for an existing file named in the message, the named-connector and failed-fetch lines, a copy_files line, a worked example in the ask rule.
- **Not added:** a "this folder" resolver and a per-turn "what's in play" block: the measurement did not show they are needed.
- **Version impact:** patch.
