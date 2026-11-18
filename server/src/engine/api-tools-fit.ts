// The API engine's tool list on a model with a small context (docs/decisions/20261118-history-small-models.md). Every
// request carries every tool's schema: about 130,000 characters for a member's full set (the intro deck alone 35,000),
// more than a 32k-token local model reads at all. On such a model the list is made smaller, in this order, only as far
// as needed to fit its share of the context:
//   1. each tool's description is cut to its first sentences (TOOL_DESC_SHORT characters);
//   2. the descriptions inside the schemas (one per argument) are left out;
//   3. the largest tools that are not file tools are left out, one by one. The instructions name them (toolsLeftOutNote),
//      so the AI says that this model cannot do that instead of acting as if the tool did not exist.
// A model with room for the whole list gets it unchanged.
import { FILE_TOOLS } from '@mycel/shared'
import { estimateTokens } from '../chat/prompt'

export type ApiTool = { type: 'function'; function: { name: string; description: string; parameters: unknown } }

/** the share of the context the tool list may take on a small model */
export const TOOLS_SHARE = 0.35
/** a description cut to about this many characters, at a sentence end */
export const TOOL_DESC_SHORT = 300
/** never left out: the file tools every answer needs (read, write, list, grep, edit …) */
const KEEP = new Set(Object.keys(FILE_TOOLS))

export const toolTokens = (tools: readonly ApiTool[]) => estimateTokens(JSON.stringify(tools))

function shortDesc(d: string): string {
  if (d.length <= TOOL_DESC_SHORT) return d
  const head = d.slice(0, TOOL_DESC_SHORT)
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'))
  return end > TOOL_DESC_SHORT / 3 ? head.slice(0, end + 1) : `${head.trimEnd()}…`
}
/** a JSON schema without its "description" fields (a property named "description" stays) */
function noDescriptions(x: unknown, inProps = false): unknown {
  if (Array.isArray(x)) return x.map((v) => noDescriptions(v))
  if (!x || typeof x !== 'object') return x
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(x)) {
    if (k === 'description' && !inProps) continue
    out[k] = noDescriptions(v, k === 'properties' && !inProps)
  }
  return out
}

/**
 * The tool list within `maxTokens` (estimated): unchanged when it fits (or `maxTokens` is undefined), else made smaller
 * as described above. `left`: the tools left out, by name.
 */
export function fitApiTools(tools: readonly ApiTool[], maxTokens: number | undefined): { tools: ApiTool[]; left: string[] } {
  if (maxTokens === undefined || toolTokens(tools) <= maxTokens) return { tools: [...tools], left: [] }
  let out: ApiTool[] = tools.map((t) => ({ ...t, function: { ...t.function, description: shortDesc(t.function.description) } }))
  if (toolTokens(out) <= maxTokens) return { tools: out, left: [] }
  out = out.map((t) => ({ ...t, function: { ...t.function, parameters: noDescriptions(t.function.parameters) } }))
  const left: string[] = []
  let total = toolTokens(out)
  const bySize = out.filter((t) => !KEEP.has(t.function.name)).map((t) => ({ name: t.function.name, size: toolTokens([t]) })).sort((a, b) => b.size - a.size)
  for (const t of bySize) {
    if (total <= maxTokens) break
    left.push(t.name)
    total -= t.size
  }
  const gone = new Set(left)
  return { tools: out.filter((t) => !gone.has(t.function.name)), left }
}

/** What the instructions say about tools left out for this model. */
export function toolsLeftOutNote(left: readonly string[]): string {
  if (!left.length) return ''
  return `## Tools this AI model cannot use\nThe AI model this team uses reads only a little at a time, so these tools were left out: ${left.join(', ')}. When a request needs one of them, say plainly that the team's current AI model is too small for it and that an admin can choose a larger model; never say it was done.`
}
