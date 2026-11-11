// Files the AI's file tools show that are not on disk: the file list's `_FILES.md` (server/src/file-list/). The file
// list installs a provider on the FileService; list, glob, grep and read (the chat engines through MCP, the remote
// connector) then show, for the person asking, the lists rendered for them at that moment. Nothing here is a team
// file: it is never written, moved or deleted, and the Files screen does not see it. A real file of the same name on
// disk stays a normal file; in a folder where the person has a virtual list, the AI's tools show the virtual one.
import type { Principal, RuleSet } from '../policy/access'

export interface VirtualFile { text: string; mtimeMs: number }

export interface VirtualFiles {
  /** the virtual files this person sees whose folder is `base` or below it (actual names; [] = the whole team), by
   * team path; `accept`: only paths it takes are rendered (glob's pattern) */
  under(user: Principal, rules: RuleSet, base: readonly string[], accept?: (path: string) => boolean): Map<string, VirtualFile>
  /** the virtual file at exactly this team path (actual names of its folder) for this person, or null */
  at(user: Principal, rules: RuleSet, segs: readonly string[]): VirtualFile | null
}
