- The API engine (a team's own API key) costs much less per question: its instructions stay the same from chat to chat
  so the provider's prompt cache reuses them, large tools such as decks and PDF editing are loaded only when a request
  needs them, and Claude models on OpenRouter are cached. Measured on Claude Sonnet: about $0.43 per question before;
  now $0.11 for the first one and about $0.02 for the next ones.
- A first answer on the API engine now waits up to 10 minutes for the provider instead of failing after 90 seconds.
- Admin › AI providers: an admin sees that the Ollama address is the owner's to set, switching to Ollama no longer
  asks to remove the old key first, and a stopped Ollama says "Ollama isn't running" instead of a network error.
