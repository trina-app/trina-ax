- A Linux server now keeps an update only when the AI engine can start with the new version. When it cannot (on
  2026-11-16 an update left the new version's files unreadable for the engine, and every AI answer failed for hours),
  the server goes back to the version before by itself, and Admin › System and the update say why.
- When the AI engine cannot start because of the server itself (not the update), the update is kept, and Admin › System
  warns that AI answers may fail until the server is fixed.
