// Connection tools to look up (docs/DECISIONS.md "Connection tools: deferred, found and called") through whole chat
// turns with the real runtime, launcher and gate and the fake engines (no model or service calls leave the machine): a
// connection of 186 tools shaped like Higgsfield's (tests/lib/big-catalog.ts) gives Claude Code, Codex, the API engine
// and Claude's sub-agents the same two tools, find_tools and call_tool, instead of 186; each finds tool #150 and runs
// it. The model proxy's names for the turn hold the two and none of the 186, so a request naming one of them directly
// stops the answer; a tool turned off is neither found nor run; a resumed session gets the short form of the list.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type EngineId } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices } from '../lib/fake-services'
import { bigCatalog, TOOL_150 } from '../lib/big-catalog'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { writeApiEngine } from '../../server/src/engine/api-agent'
import { checkToolNames, toolPolicyOf } from '../../server/src/proxy/model-proxy'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const SEP = { say: '\n----\n' }
const FULL = `my_studio__${TOOL_150}`
const ARGS = { video_url: 'https://v.example/clip.mp4', focus: 'retention' }

/** Chat Completions stream: text, then tool calls. */
function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: string[] = []
  for (const t of o.text ?? []) lines.push(JSON.stringify({ choices: [{ delta: { content: t } }] }))
  for (const [i, c] of (o.calls ?? []).entries()) lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] }))
  lines.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}

let h: Harness
let svc: FakeServices
let mock: ReturnType<typeof Bun.serve>
let studio: { id: string }
const seen: any[] = []
const script: string[] = []

beforeAll(async () => {
  mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }); seen.push(await req.json()); return new Response(script.shift() ?? sse({ text: ['(no script)'] })) } })
  h = await startHarness({ name: 'c-deferred-turns' })
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
  const confs = h.rt().engines.get()
  confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
  delete confs.problems.api
  setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
  svc.tools = bigCatalog()
  svc.pageSize = 1000
  studio = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Studio', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask' } })
  expect((studio as any).tools).toHaveLength(186)
})
afterAll(async () => { await h?.close(); mock?.stop(true); svc?.stop() })

const answer = async (assistantId: string) => {
  await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(assistantId) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 60_000 })
  const m = h.ctx.db.query('SELECT status, content, steps, error FROM messages WHERE id = ?').get(assistantId) as { status: string; content: string; steps: string; error: string | null }
  if (m.status !== 'done') throw new Error(`turn ended ${m.status}: ${m.error}`)
  return { content: m.content, steps: JSON.parse(m.steps) as { tool?: string; label: string; status: string; parentId?: string }[] }
}
const send = async (user: string, chatId: string, content: string, engine?: EngineId) => {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], ...(engine ? { engine } : {}) } })
  return { turnId: r.turnId, ...(await answer(r.assistantMessage.id)) }
}
const newChat = async (user: string, engine?: EngineId) => (await h.api(user).call(API.createChat, { body: engine ? { engine } : {} })).id
const events = (turnId: string, tool: string) => h.ctx.db.query('SELECT summary, ok, parent_tool_use_id AS parent FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY id').all(turnId, tool) as { summary: string; ok: number; parent: string | null }[]
const studioNames = (names: string[]) => names.filter((n) => n.includes('my_studio__'))
const find = { tool: 'find_tools', args: { query: 'analyze video retention' }, sayResult: true }
const run = { tool: 'call_tool', args: { name: FULL, arguments: ARGS }, sayResult: true }

describe('the same two tools for every engine and sub-agent', () => {
  test('Claude Code: find_tools and call_tool instead of 186; the model proxy allows the two and none of the 186', async () => {
    const before = svc.calls.length
    const r = await send('alice', await newChat('alice'), fake({ echo: 'tools' }, SEP, { echo: 'args' }, SEP, { echo: 'system' }, SEP, find, SEP, run))
    const [tools, argsJson, system, found, ran] = r.content.split('\n----\n')
    expect(tools!.split(',')).toEqual(expect.arrayContaining(['find_tools', 'call_tool']))
    expect(studioNames(tools!.split(','))).toEqual([])
    const argv = JSON.parse(argsJson!) as string[]
    const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',')
    expect(allowed).toEqual(expect.arrayContaining(['mcp__team__find_tools', 'mcp__team__call_tool']))
    expect(studioNames(allowed)).toEqual([])
    // the instructions list the tools to look up within their budget
    expect(system).toContain('- Studio (personal connection, MCP server): 186 tools, not loaded')
    expect(system).toContain(`- ${TOOL_150}\n`)
    // #150 found with its schema, and run: its answer is external data
    expect(found).toContain(`## ${FULL}`)
    expect(found).toContain('"video_url"')
    expect(ran).toContain('<external_data source="Studio">')
    expect(svc.calls.slice(before).map((c) => [c.name, c.args])).toEqual([[TOOL_150, ARGS]])
    expect(r.steps.find((s) => s.tool === 'find_tools')).toMatchObject({ label: 'Find features "analyze video retention"', status: 'ok' })
    expect(r.steps.find((s) => s.tool === 'call_tool')).toMatchObject({ label: 'Studio · Video analysis', status: 'ok' })
    expect(events(r.turnId, 'call_tool').map((e) => e.summary.split(' (')[0])).toEqual([`${FULL} -> ok`])
    // the model proxy's names for this turn
    const row = h.ctx.db.query('SELECT tools FROM proxy_tokens WHERE turn_id = ? ORDER BY rowid DESC LIMIT 1').get(r.turnId) as { tools: string } | null
    const policy = toolPolicyOf(row!)
    expect(policy.team).toEqual(expect.arrayContaining(['find_tools', 'call_tool']))
    expect(studioNames([...policy.team!])).toEqual([])
    expect(checkToolNames({ tools: [{ name: 'mcp__team__find_tools' }, { name: 'mcp__team__call_tool' }] }, policy)).toBeNull()
    expect(checkToolNames({ tools: [{ name: `mcp__team__${FULL}` }] }, policy)).toContain(`mcp__team__${FULL}`)
  })

  test('Codex: the team server\'s enabled tools are the two; a call through call_tool reaches the service', async () => {
    const before = svc.calls.length
    const r = await send('alice', await newChat('alice', 'codex' as EngineId), fake({ echo: 'args' }, SEP, find, SEP, run), 'codex' as EngineId)
    const [argsJson, found, ran] = r.content.split('\n----\n')
    const enabled = (JSON.parse(argsJson!) as string[]).find((a) => a.startsWith('mcp_servers.team.enabled_tools='))!
    const names = JSON.parse(enabled.slice('mcp_servers.team.enabled_tools='.length)) as string[]
    expect(names).toEqual(expect.arrayContaining(['find_tools', 'call_tool']))
    expect(studioNames(names)).toEqual([])
    expect(found).toContain(`## ${FULL}`)
    expect(ran).toContain('<external_data source="Studio">')
    expect(svc.calls.slice(before).map((c) => c.name)).toEqual([TOOL_150])
  })

  test('the API engine: offered as two functions (the request stays small); the model finds and runs #150', async () => {
    // the size of what each model request carries as tools, without and with the connection
    seen.length = 0
    script.push(sse({ text: ['ok'] }))
    await send('bob', await newChat('bob', 'api' as EngineId), 'hello', 'api' as EngineId)
    const without = JSON.stringify(seen[0].tools).length
    seen.length = 0
    const before = svc.calls.length
    script.push(
      sse({ calls: [{ id: 'c1', name: 'find_tools', args: JSON.stringify({ query: 'video analysis' }) }] }),
      sse({ calls: [{ id: 'c2', name: 'mcp__team__call_tool', args: JSON.stringify({ name: FULL, arguments: ARGS }) }] }),
      sse({ text: ['Here is the report.'] }),
    )
    const r = await send('alice', await newChat('alice', 'api' as EngineId), 'analyze my clip', 'api' as EngineId)
    expect(r.content).toBe('Here is the report.')
    const fns = seen[0].tools.map((t: any) => t.function.name) as string[]
    expect(fns).toEqual(expect.arrayContaining(['find_tools', 'call_tool']))
    expect(studioNames(fns)).toEqual([])
    const added = JSON.stringify(seen[0].tools).length - without
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThan(2_500)
    // the system prompt holds the list; the tool results are what the AI saw
    expect(String(seen[0].messages[0].content)).toContain('### Tools to look up')
    const results = seen[2].messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    expect(results[0]).toContain(`## ${FULL}`)
    expect(results[1]).toContain('<external_data source="Studio">')
    expect(svc.calls.slice(before).map((c) => [c.name, c.args])).toEqual([[TOOL_150, ARGS]])
  })

  test('sub-agents: the general-purpose helper has the two (Explore has neither) and its calls are its own, as alice', async () => {
    const before = svc.calls.length
    const chat = await newChat('alice')
    const r = await send('alice', chat, fake({ echo: 'agents' }, SEP, { echo: 'subagentPrompt' }, SEP, { agents: [
      { id: 'toolu_D1', type: 'general-purpose', description: 'Analyze the clip', steps: [{ tool: 'find_tools', args: { query: `select:${FULL}` } }, { tool: 'call_tool', args: { name: FULL, arguments: ARGS } }] },
    ] }))
    const [agentsJson, childPrompt] = r.content.split('\n----\n')
    const defs = JSON.parse(agentsJson!)
    expect(defs['general-purpose'].tools).toEqual(expect.arrayContaining(['mcp__team__find_tools', 'mcp__team__call_tool']))
    expect(defs.Explore.tools).not.toContain('mcp__team__call_tool')
    expect(studioNames(defs['general-purpose'].tools)).toEqual([])
    expect(childPrompt).toContain('### Tools to look up')
    expect(events(r.turnId, 'find_tools').map((e) => [e.summary, e.parent])).toEqual([[`find_tools "select:${FULL}" -> 1 found: ${FULL}`, 'toolu_D1']])
    expect(events(r.turnId, 'call_tool').map((e) => [e.summary.split(' (')[0], e.parent, e.ok])).toEqual([[`${FULL} -> ok`, 'toolu_D1', 1]])
    expect(svc.calls.slice(before).map((c) => c.name)).toEqual([TOOL_150])
    expect(r.steps.filter((s) => s.parentId === 'toolu_D1').map((s) => s.tool)).toEqual(['find_tools', 'call_tool'])
  })
})

describe('turned off, and a chat that goes on', () => {
  test('a tool turned off is not listed, not found and not run in a turn; nothing reaches the service', async () => {
    await h.api('alice').call(API.setIntegrationTool, { params: { id: studio.id }, body: { name: TOOL_150, enabled: false } })
    try {
      const before = svc.calls.length
      const r = await send('alice', await newChat('alice'), fake({ echo: 'system' }, SEP, find, SEP, run))
      const [system, found, ran] = r.content.split('\n----\n')
      expect(system).not.toContain(`- ${TOOL_150}\n`)
      expect(system).toContain('185 tools, not loaded')
      expect(found).not.toContain(FULL)
      expect(ran).toContain(`There is no tool "${FULL}" for this user now`)
      expect(svc.calls.length).toBe(before)
      expect(events(r.turnId, 'call_tool').map((e) => [e.summary, e.ok])).toEqual([[`call_tool ${FULL} -> unknown tool`, 0]])
    } finally { await h.api('alice').call(API.setIntegrationTool, { params: { id: studio.id }, body: { name: TOOL_150, enabled: true } }) }
  })

  test('a resumed Claude session gets the short form with each message, not the whole list again', async () => {
    const chat = await newChat('alice')
    const first = await send('alice', chat, fake({ say: 'first' }))
    expect(first.content).toBe('first')
    const again = await send('alice', chat, fake({ echo: 'resume' }, SEP, { echo: 'message' }))
    const [resumed, message] = again.content.split('\n----\n')
    expect(resumed).toContain('true')
    expect(message).toContain('<turn_context>')
    expect(message).toContain('186 tools of Studio are not loaded')
    expect(message).not.toContain(`- ${TOOL_150}\n`)
  })
})

describe("a mid-sized connection over Claude Code's 10% line (MAX_TURN_TOOL_CHARS)", () => {
  // erin: a small connection that stays tools of its own, and 12 tools of the big catalog (about 70,000 characters of
  // definitions: under the old 256,000 they went to the engine whole, now they are looked up)
  const MID = 'my_mid__' + bigCatalog(12)[0]!.name
  const midArgs = { prompt: 'a cat on a sofa' }
  beforeAll(async () => {
    const before = svc.tools
    try {
      svc.tools = bigCatalog(3).map((t) => ({ ...t, name: 'note_' + t.name }))
      await h.api('erin').call(API.createIntegration, { body: { kind: 'mcp', name: 'Notes', url: `${svc.base}/mcp-open?notes`, auth: 'none', writePolicy: 'ask' } })
      svc.tools = bigCatalog(12)
      await h.api('erin').call(API.createIntegration, { body: { kind: 'mcp', name: 'Mid', url: `${svc.base}/mcp-open?mid`, auth: 'none', writePolicy: 'ask' } })
    } finally { svc.tools = before }
  })
  const mine = (names: string[], key: string) => names.filter((n) => n.includes(`my_${key}__`))
  const midFind = { tool: 'find_tools', args: { query: `select:${MID}` }, sayResult: true }
  const midRun = { tool: 'call_tool', args: { name: MID, arguments: midArgs }, sayResult: true }

  test('Claude Code and Codex: the small one by name, the mid-sized one through find_tools and call_tool', async () => {
    for (const engine of [undefined, 'codex' as EngineId]) {
      const before = svc.calls.length
      const r = await send('erin', await newChat('erin', engine), fake({ echo: 'args' }, SEP, midFind, SEP, midRun), engine)
      const [argsJson, found, ran] = r.content.split('\n----\n')
      const argv = JSON.parse(argsJson!) as string[]
      const names = engine
        ? JSON.parse(argv.find((a) => a.startsWith('mcp_servers.team.enabled_tools='))!.slice('mcp_servers.team.enabled_tools='.length)) as string[]
        : argv[argv.indexOf('--allowedTools') + 1]!.split(',')
      expect(mine(names, 'notes')).toHaveLength(3)
      expect(mine(names, 'mid')).toEqual([])
      expect(names.some((n) => n.endsWith('find_tools')) && names.some((n) => n.endsWith('call_tool'))).toBe(true)
      expect(found).toContain(`## ${MID}`)
      expect(ran).toContain('<external_data source="Mid">')
      expect(svc.calls.slice(before).map((c) => [c.name, c.args])).toEqual([[MID.slice('my_mid__'.length), midArgs]])
    }
  })

  test('the API engine: the small one as functions of their own, the mid-sized one through the two', async () => {
    seen.length = 0
    const before = svc.calls.length
    script.push(
      sse({ calls: [{ id: 'm1', name: 'find_tools', args: JSON.stringify({ query: `select:${MID}` }) }] }),
      sse({ calls: [{ id: 'm2', name: 'call_tool', args: JSON.stringify({ name: MID, arguments: midArgs }) }] }),
      sse({ text: ['Done.'] }),
    )
    const r = await send('erin', await newChat('erin', 'api' as EngineId), 'make a picture', 'api' as EngineId)
    expect(r.content).toBe('Done.')
    const fns = seen[0].tools.map((t: any) => t.function.name) as string[]
    expect(mine(fns, 'notes')).toHaveLength(3)
    expect(mine(fns, 'mid')).toEqual([])
    expect(fns).toEqual(expect.arrayContaining(['find_tools', 'call_tool']))
    expect(String(seen[0].messages[0].content)).toContain('- Mid (personal connection, MCP server): 12 tools, not loaded')
    expect(svc.calls.slice(before).map((c) => [c.name, c.args])).toEqual([[MID.slice('my_mid__'.length), midArgs]])
  })
})
