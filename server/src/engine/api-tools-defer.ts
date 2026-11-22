// The API engine's tools on demand (docs/decisions/20261120-api-engine-stable-prompt.md). Every round of an answer sends
// the whole function list, and a member's list was 150,000 characters (57 tools; the intro deck alone 33,000): about
// 37,000 tokens of every request, paid again on every tool round. The large or rarely needed tools below are not sent
// as functions; the instructions name each with its first sentence, and load_tools (answered here in the API engine
// loop, never an MCP tool) adds the ones the model names for the rest of the answer, as Claude Code loads deferred tools
// with its tool search. Calling one of them by name without loading it works too: the MCP handler checks every call as
// always. Claude Code and Codex get the full list from the gate, unchanged (tests/unit/engine-prompt-pin.test.ts).
import { firstSentence, oneLine } from '../integrations/connections/deferred'
import type { ApiTool } from './api-tools-fit'

/** sent only when loaded: decks and videos, PDF and Office editing, zip, schedules, access changes, skill files */
export const API_DEFERRED_TOOLS: ReadonlySet<string> = new Set([
  'intro_deck', 'promo_video', 'save_promo_video',
  'edit_pdf', 'stamp_pdf', 'merge_pdfs', 'split_pdf', 'edit_office', 'comment_docx',
  'resize_images', 'unzip_file', 'make_zip',
  'schedule_create', 'schedule_list', 'schedule_delete',
  'change_folder_access', 'change_project_members', 'share_folder',
  'move_skill', 'skill_files', 'save_connector_file',
])

export const LOAD_TOOLS = 'load_tools'
/** a listed tool's line: its first sentence, at most this many characters */
const LINE_MAX = 200

/** The function the model calls to get listed tools (its names: every deferred tool of the turn, the same all answer). */
function loadToolsDef(names: readonly string[]): ApiTool {
  return { type: 'function', function: {
    name: LOAD_TOOLS,
    description: 'Load tools listed under "More tools" in the instructions, so you can call them. Give every name you need in one call; they stay loaded for the rest of this answer.',
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string', enum: [...names] }, minItems: 1, description: 'tool names from the list' } }, required: ['names'], additionalProperties: false },
  } }
}

/**
 * The tools a round sends: every tool that is not deferred (in the list's order), then the deferred ones loaded (in the
 * order they were loaded: the start of the list stays as it was, for the provider's cache), then load_tools while some
 * are left. `listed`: the deferred tools not loaded yet.
 */
export function apiOfferedTools(all: readonly ApiTool[], loaded: ReadonlySet<string> = new Set()): { tools: ApiTool[]; listed: ApiTool[] } {
  const byName = new Map(all.map((t) => [t.function.name, t]))
  const tools = all.filter((t) => !API_DEFERRED_TOOLS.has(t.function.name))
  for (const n of loaded) { const t = byName.get(n); if (t && API_DEFERRED_TOOLS.has(n)) tools.push(t) }
  const listed = all.filter((t) => API_DEFERRED_TOOLS.has(t.function.name) && !loaded.has(t.function.name))
  if (listed.length) tools.push(loadToolsDef(deferredOf(all).map((t) => t.function.name)))
  return { tools, listed }
}

/** The instructions' list of tools to load, one line each. It names every deferred tool of the turn, also after some
 * are loaded, so the instructions stay the same through the answer (and the provider's cache with them). */
export function moreToolsNote(deferred: readonly ApiTool[]): string {
  if (!deferred.length) return ''
  const lines = deferred.map((t) => `- ${t.function.name}: ${firstSentence(oneLine(t.function.description), LINE_MAX)}`)
  return [
    '## More tools',
    `These tools are not loaded yet. When a request needs one, call ${LOAD_TOOLS} with its name (several at once is fine), then call it. Never say you cannot do something one of them does: load it first. The rules above that name them apply once loaded. These names are for you: in an answer, say what a tool does, never its name.`,
    ...lines,
  ].join('\n')
}

/** The deferred tools of a list (the ones the instructions name). */
export const deferredOf = (all: readonly ApiTool[]) => all.filter((t) => API_DEFERRED_TOOLS.has(t.function.name))

/** load_tools' answer, and the names it loaded. Unknown names are said back with the ones that exist. */
export function loadTools(args: unknown, all: readonly ApiTool[], loaded: Set<string>): { text: string; ok: boolean } {
  const names = Array.isArray((args as { names?: unknown })?.names) ? ((args as { names: unknown[] }).names).filter((n): n is string => typeof n === 'string') : []
  const deferred = new Set(deferredOf(all).map((t) => t.function.name))
  const known = names.filter((n) => deferred.has(n))
  const unknown = names.filter((n) => !deferred.has(n))
  for (const n of known) loaded.add(n)
  if (!known.length) return { ok: false, text: `Error: no tool of that name to load. Tools you can load: ${[...deferred].join(', ') || '(none)'}.` }
  return { ok: true, text: `Loaded: ${known.join(', ')}. Call ${known.length === 1 ? 'it' : 'them'} now.${unknown.length ? ` Not found: ${unknown.join(', ')} (already loaded tools need no loading).` : ''}` }
}
