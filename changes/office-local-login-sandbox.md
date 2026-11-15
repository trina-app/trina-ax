- **Office Mac with its own Claude login:** the AI engine can no longer open the Mac's keychain. It cannot run the
  `security` tool, read the keychain files or the Claude login file. Claude Code still signs in: a small helper of the
  team server gives it the Mac's Claude sign-in and nothing else of the keychain, keeps the long-lived renewal
  token to itself, and saves a renewed sign-in back.
