- The file list is always on: Admin › Team settings › File list no longer has an off switch, only its status and
  **Run now**. A team that had turned it off gets it back, and its files are read again over the next nights. Only the
  server's host can still turn it off (`server.json`).
- The in-app AI is told the file list is up to a night old: a file added or changed today may be missing or described as
  it was, so the AI searches names and contents before it says a file is not there, and answers from the opened file.
