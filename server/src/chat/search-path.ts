// Where a chat's search looks when the AI gives no folder (docs/DECISIONS.md "Shared project chats"): in a shared chat
// a search without a path never starts at the team root (TurnExec.sharedArgs); "/" alone asks a shared project chat's
// search for every folder the person can open, behind the read card.
/** A search's path that names no folder: none, empty, or only separators and "." ("/", "./", "//", "\\", " . ") —
 * the team root, which a shared chat never searches by default (TurnExec.sharedArgs). */
export const noSearchPath = (p: unknown): boolean => typeof p !== 'string' || p.replace(/\\/g, '/').split('/').every((s) => s.trim() === '' || s.trim() === '.')
/** The path that asks a shared project chat's search to look through every team folder the person can open (the read card
 * asks first for what some of the chat's people cannot open): "/" alone. Any other path without a folder stays in the
 * project folder (TurnExec.sharedArgs). */
export const WHOLE_TEAM_PATH = '/'
export const wholeTeamPath = (p: unknown): boolean => typeof p === 'string' && p.trim() === WHOLE_TEAM_PATH
/** What a search that stayed in a shared project chat's folder tells the AI, once a turn (the AI took a project-only
 * result for the whole team folder: AI scenario FIND-01.project, 2026-11-17). Names no folder: the AI writes where
 * everyone in the chat reads. */
export const PROJECT_SEARCH_NOTE = `(Searched only this project's folder: in this shared chat grep and glob without a path stay there, so files in other team folders and in the user's own folder were not looked at. When the file may be elsewhere, search again with path "${WHOLE_TEAM_PATH}": it looks through every team folder the user can open, and where some people here cannot open one, the user is asked first on a card only they see. Until then, do not call a result here the only one, and do not say a file does not exist.)`
