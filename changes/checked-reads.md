- Security: file reads now use the file that was checked. The AI's read tools, the file screen's text view and the
  other places that read a team file read it once, from the same open file that passed the permission check; a link
  placed under a personal folder is never followed, also when a folder changes while the file is being opened.
