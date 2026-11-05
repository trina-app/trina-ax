// The tools whose results are only the team's files and the person's own data (docs/DECISIONS.md "S — The lead's way
// becomes a team skill", review fixes). A conversation that used any other tool (web search and pages, the browser,
// Google Drive, saved web pages, generated video, connections and their api_request, plugin tools, the dev box) brought
// in content the team does not own, so it cannot become a team skill. An allowlist on purpose: a tool added later is
// outside until it is listed here (fails closed). Built from the tools' own name lists where they export one; the
// engines run nothing else (Claude Code's lockdown: our tools, WebSearch, the Agent tool; engine/claude.ts).
import { EDIT_FILES_TOOL, FILE_TOOLS } from '@mycel/shared'
import { C_TOOL_NAMES } from '../tools'
import { FILE_MOVE_TOOL_NAMES } from '../tools/file-moves'
import { SCHEDULE_TOOL_NAMES } from '../tools/schedules'
import { DEMO_REPLAY_TOOL } from '../demo/replay'

/** C's tools that reach outside (the rest of C_TOOL_NAMES work on team files) */
const C_OUTSIDE = new Set<string>(['web_fetch', 'save_url'])

let list: ReadonlySet<string> | null = null
/** built on first use (the tool modules import each other; nothing is read while they load) */
export function teamContentTools(): ReadonlySet<string> {
  return (list ??= new Set([
  ...Object.keys(FILE_TOOLS), EDIT_FILES_TOOL, ...C_TOOL_NAMES.filter((n) => !C_OUTSIDE.has(n)), ...FILE_MOVE_TOOL_NAMES, ...SCHEDULE_TOOL_NAMES,
  // the chat's own tools (chat/tools.ts) and the team search (tools/search.ts)
  'skill', 'find_skills', 'remember', 'forget', 'ask_user', 'connect_service', 'set_title', 'search',
  // a sub-task: its own steps are checked one by one
  'agent', 'Agent', 'Task',
  // steps the server writes itself
  'engine', 'attachment', 'refusal', DEMO_REPLAY_TOOL,
]))
}

/** A step's tool name without the engine's prefix for our server ("mcp__team__read" → "read"); another server's
 * prefix stays (and is outside). */
export const bareToolName = (name: string): string => name.replace(/^mcp__team__/, '')

/** The tool brought in content that is not the team's own (any tool not on the list). */
export const outsideContentTool = (name: string): boolean => !teamContentTools().has(bareToolName(name))
