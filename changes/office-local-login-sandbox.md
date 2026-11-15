- **Office Mac with its own Claude login:** the AI engine can no longer open the Mac's keychain. It cannot run the
  `security` tool, read the keychain files or the Claude login file. Claude Code still signs in: a small helper of the
  team server gives it the Mac's Claude login and nothing else of the keychain, and saves a renewed login back.
