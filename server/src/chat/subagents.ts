// Sub-agents (A5 stage 1, docs/DECISIONS.md "Sub-agents"): Claude Code's Agent tool, so a chat's AI can hand parts of
// a big request to child agents the way Claude Code does. A child has the same tools as the AI that started it (minus
// the ones only the main AI may use, like Claude Code takes AskUserQuestion away from its subagents) and the same
// person's access: its calls go over the turn's one tool connection to the same gate, which checks that person's
// access on every call and writes the same audit rows.
//
// The two definitions here are the only sub-agents a turn has (`--agents`, with Claude Code's built-in ones switched
// off): Claude Code's own names, so a call without subagent_type runs ours. Their `tools` name our tools exactly;
// never a built-in file tool (a definition that lists Glob or Grep gets them back even with Bash denied).
import { CLAUDE_AGENT_TOOL_NAMES, ENGINE_BUILTIN_ALLOWED, SUBAGENT_TYPES, TEAM_TOOL_PREFIX } from '@mycel/shared'
import { BROWSER_TOOL_NAMES } from '../realtime/browser-tools'
export { MAX_CONCURRENT_SUBAGENTS } from '../engine/claude'

/** tools/schedules.ts SCHEDULE_TOOL_NAMES (not imported: that module reaches the chat runtime; a test keeps them equal) */
export const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_delete'] as const
/** model rounds of one sub-agent (Claude Code: no limit). At the limit Claude Code hands back no report, only a note
 * that it stopped (review S3, seen with 2.1.305): the child prompt asks for a report of what is done before that. */
export const MAX_SUBAGENT_TURNS = 50

/**
 * Tools only the main AI has. Like Claude Code's AskUserQuestion: a sub-agent cannot ask the person (it writes what it
 * does not know into its report and the main AI asks). The chat title, memories (Claude Code subagents do not get the
 * main session's memory), schedules and videos (side effects and cost the person decides on with the main AI) and the
 * desktop browser (one screen of the person's, not to be driven by several agents at once) stay with the main AI.
 * Turn.patchToolStep relies on this: every tool that patches its step is here, so its FIFO per tool stays right.
 */
export const PARENT_ONLY_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'set_title', 'remember', 'forget', ...SCHEDULE_TOOLS, 'generate_video', ...BROWSER_TOOL_NAMES])
/** what the read-only Explore helper may use (of the tools the turn has) */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['list', 'glob', 'grep', 'read', 'search', 'drive_list', 'drive_read', 'drive_search', 'hwp_render', 'web_fetch'])

export interface AgentDefinition {
  description: string
  prompt: string
  tools: string[]
  disallowedTools: string[]
  model: 'inherit'
  maxTurns: number
  omitClaudeMd: true
}

/**
 * The `--agents` file of one turn. `tools`: our tool names offered to this turn (no prefix: the six file tools and
 * the turn's other tools); `webSearch`: the turn has Claude Code's WebSearch (not in confidential chats or approved
 * template runs). Claude Code never gives a child a tool its main session lacks; the lists say it a second time.
 */
export function buildAgentDefinitions(o: { tools: string[]; webSearch: boolean; maxTurns?: number }): Record<(typeof SUBAGENT_TYPES)[number], AgentDefinition> {
  const ours = [...new Set(o.tools)].filter((t) => !PARENT_ONLY_TOOLS.has(t))
  const web = o.webSearch ? [...ENGINE_BUILTIN_ALLOWED] : []
  const denied = ['Agent', ...[...PARENT_ONLY_TOOLS].filter((t) => o.tools.includes(t)).map((t) => TEAM_TOOL_PREFIX + t)]
  const base = { model: 'inherit' as const, maxTurns: o.maxTurns ?? MAX_SUBAGENT_TURNS, omitClaudeMd: true as const, disallowedTools: denied }
  return {
    'general-purpose': {
      ...base,
      description: 'A helper for one self-contained part of the user\'s request: finding, reading and comparing team files, drafting, and saving results in the team drive. It has your team tools and the user\'s access, cannot ask the user anything, and does not see this conversation. Returns one report.',
      prompt: 'You are a helper of the team assistant. You do one part of the user\'s request, as the assistant described it in your task, and report back to the assistant.',
      tools: [...ours.map((t) => TEAM_TOOL_PREFIX + t), ...web],
    },
    Explore: {
      ...base,
      description: 'A fast read-only helper for research in the team drive (and on the web when this chat allows it): finding files, reading and summarizing them. It cannot change or save files. Returns one report.',
      prompt: 'You are a read-only research helper of the team assistant. Find and read what your task needs and report back to the assistant. You cannot change or save files.',
      tools: [...ours.filter((t) => EXPLORE_TOOLS.has(t)).map((t) => TEAM_TOOL_PREFIX + t), ...web],
    },
  }
}

/**
 * Claude Code's own report of what it started with (system/init) against the lockdown: besides our mcp__team__ tools
 * only WebSearch (when the turn has it) and the Agent tool (when the turn has sub-agents; 2.1.305 lists it as Task),
 * and no sub-agent definitions besides ours (a managed-settings or disk definition would show here). null = fine,
 * else why not. The children's own tools are not in this event: the model proxy checks every request (managed mode).
 */
export function initProblem(init: { tools: string[]; agents: string[] }, o: { webSearch: boolean; subagents: boolean }): string | null {
  const extra = init.tools.filter((t) => !t.startsWith(TEAM_TOOL_PREFIX)
    && !(o.webSearch && (ENGINE_BUILTIN_ALLOWED as readonly string[]).includes(t))
    && !(o.subagents && CLAUDE_AGENT_TOOL_NAMES.includes(t)))
  if (extra.length) return `engine tools outside the lockdown: ${extra.slice(0, 10).join(', ').slice(0, 300)}`
  const agents = init.agents.filter((a) => !(o.subagents && (SUBAGENT_TYPES as readonly string[]).includes(a)))
  if (agents.length) return `sub-agent definitions besides ours: ${agents.slice(0, 10).join(', ').slice(0, 300)}`
  return null
}

/** Office mode with the Mac user's own Claude login (local-login): confidential chats get no Agent tool until the
 * manual check with a real login (plan review M4) has shown that `isolation: "remote"` cannot open a cloud session
 * through the office tunnel there. --restricted already refuses it in the 2.1.305 code; this keeps the web lockdown of
 * confidential chats independent of that until someone has seen it. */
export const LOCAL_LOGIN_CONFIDENTIAL_SUBAGENTS = false

/** sub-agent steps kept with the saved answer per sub-task (the most recent; review M6): the step list is saved whole
 * every 0.3 s and has no other cap, and a sub-agent may take many steps */
export const SUBTASK_STEPS_KEPT = 30

/** One line of the audit log (tool_events, tool 'agent') for a sub-task's start or end; never its prompt or report. */
export function subtaskSummary(o: { type: string; description: string; end?: { ok: boolean | 'stopped'; toolUses?: number; ms?: number } }): string {
  const d = JSON.stringify(o.description.replace(/\s+/g, ' ').slice(0, 80))
  if (!o.end) return `agent ${o.type} started: ${d}`
  const stats = [o.end.toolUses !== undefined ? `${o.end.toolUses} tool uses` : '', o.end.ms !== undefined ? `${Math.round(o.end.ms / 1000)} s` : ''].filter(Boolean).join(', ')
  return `agent ${o.type} ${o.end.ok === 'stopped' ? 'stopped with the answer' : o.end.ok ? 'done' : 'failed'}: ${d}${stats ? ` (${stats})` : ''}`
}
