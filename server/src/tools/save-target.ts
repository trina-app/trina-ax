// Where a save tool puts a file, as the AI typed it (save_as, to_folder): the one way to read that path, shared by the
// tools (save-url.ts, save-connector-file.ts, unzip.ts) and a shared chat's card gate (chat/turn.ts sharedSources), so
// the gate weighs the very place the tool then writes to (docs/decisions/20261118-shared-save-card-wording.md; security
// review of #1314: the gate read " users/alice/x" or "/users/alice/" as no path while the tool trimmed it and saved there).

/** Spaces around it, "\" for "/", leading "/" dropped, NFC. A trailing "/" (a folder) is kept. */
export function savePathArg(v: string): string {
  return v.trim().replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC')
}
