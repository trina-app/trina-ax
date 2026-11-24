# In a shared chat the others learn who a card waits for, never what it asks

- Date: 2026-11-24
- Status: accepted
- Supersedes: in [20261123-shared-chat-others-steps.md](20261123-shared-chat-others-steps.md), the name of a connection's step in another person's record; the words of another person's open question in `<closed_question>` (S-125)
- Branch: fix/shared-chat-waiting

- **Ask:** teammates should know a chat is stuck on someone's permission card, and nothing of the card.
- **Who it waits for** (`Chat.waitsFor`, `ChatRuntime.waitingOn`): while a turn runs, only that turn's open cards; when idle, only the cards of the chat's latest turn. A one-window card counts while that window is connected. Nobody counts who no longer sees the chat.
- **Step lines fail closed:** for anyone but the person whose turn it is, and for their AI, a step shows its generic verb unless its tool is on one short list (`PATH_LABEL_TOOLS`, `OPEN_LABEL_TOOLS` in `chat/open-questions.ts`). Stored rows follow the same rule.
  - File tools and `save_url`: their line only with its paths kept aside, shown to whoever may list them all.
  - A command and its output stay visible ([20261118-devenv-shared-chats.md](20261118-devenv-shared-chats.md)), so a command line can name a host its site card asks about.
  - Screenshots the AI shared to the chat stay.
  - Only built-in tools keep their name (`knownStepTool`), plus the server's own step kinds (`internalStepTool`), which the apps group and draw by. Connectors, `call_tool`, `api_request` and anything unknown lose it.
- **`<closed_question>`:** a teammate's AI gets the person's name only. Whether a teammate's message closes the question is unchanged and is an open product decision.
- **Tests:** `tests/unit/b-shared-chat-waits-for.test.ts`, `tests/security/shared-chat-waits-for.test.ts`, `tests/unit/dev-env-shared-chat.test.ts`.
- **Version impact:** patch.
