// The "api" engine's grounding (QA B-API-1, B-API-2): a failed tool call goes back to the model and the loop lets it
// correct the call; team-file links in the answer must come from a tool result (engine/api-links.ts); the
// instructions ask for grounded answers. Unit tests with a stand-in fetch, and one chat turn against a stand-in
// OpenAI-compatible server through the real runtime.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, fileShareUrl, type EngineId } from '@mycel/shared/api'
import type { EngineEvent } from '@mycel/shared'
import { API_GROUNDING_RULES, runApiAgent, writeApiEngine, type ApiEngineConf } from '../../server/src/engine/api-agent'
import { LinkGuard } from '../../server/src/engine/api-links'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import { conflictCopyName } from '../../server/src/files/store'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)

function sse(o: { text?: string[]; calls?: { id: string; name: string; args: string }[] }): string {
  const lines: string[] = []
  for (const t of o.text ?? []) lines.push(JSON.stringify({ choices: [{ delta: { content: t } }] }))
  for (const [i, c] of (o.calls ?? []).entries()) lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: c.args } }] } }] }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}

const conf: ApiEngineConf = { baseUrl: 'https://api.example/v1', model: 'm-1', label: 'M1', key: null }
const textOf = (events: EngineEvent[]) => events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')

/** Run the loop with scripted replies; returns the events, the request bodies and the tool calls. */
async function run(replies: string[], tool: (args: any, n: number) => Promise<any>, o: { message?: string; systemPrompt?: string; origins?: string[] } = {}) {
  const bodies: any[] = []
  const f = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(replies.shift() ?? sse({ text: ['(no script)'] })) }) as unknown as typeof fetch
  const calls: any[] = []
  const rpc = async (m: any) => {
    if (m.method === 'tools/list') return { result: { tools: [{ name: 'make_file', description: 'Make a file', inputSchema: { type: 'object' } }, { name: 'share_file', description: 'Share', inputSchema: { type: 'object' } }] } }
    calls.push(m.params)
    return tool(m.params.arguments, calls.length)
  }
  const events: EngineEvent[] = []
  await runApiAgent({ conf, systemPrompt: o.systemPrompt ?? 'sys', message: o.message ?? 'make it', rpc, emit: (e) => events.push(e), signal: new AbortController().signal, fetchFn: f, publicOrigins: o.origins })
  return { events, bodies, calls }
}

describe('tool errors go back to the model (B-API-1)', () => {
  test('an error result is the tool answer, the loop goes on and the corrected call works', async () => {
    const r = await run([
      sse({ calls: [{ id: 'c1', name: 'make_file', args: '{"format":"pptx","slides":6}' }] }),
      sse({ calls: [{ id: 'c2', name: 'make_file', args: '{"format":"pptx","slides":5}' }] }),
      sse({ text: ['Made 5 slides.'] }),
    ], async (a) => a.slides === 5
      ? { result: { content: [{ type: 'text', text: 'Saved deck.pptx' }] } }
      : { result: { content: [{ type: 'text', text: 'Error: the deck has 6 slides, 5 were asked for' }], isError: true } })
    expect(r.calls.map((c) => c.arguments.slides)).toEqual([6, 5])
    expect(r.events.filter((e) => e.type === 'tool_end').map((e) => (e as { ok: boolean }).ok)).toEqual([false, true])
    // the second request carries the error, the third the success
    expect(r.bodies[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: expect.stringContaining('6 slides, 5 were asked for') })
    expect(r.bodies[2].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c2', content: 'Saved deck.pptx' })
    expect(textOf(r.events)).toBe('Made 5 slides.')
    expect(r.events.at(-1)).toEqual({ type: 'done' })
    expect(r.events.some((e) => e.type === 'error')).toBe(false)
  })

  test('a handler that throws and arguments that are not JSON are tool answers too; the loop does not stop', async () => {
    const r = await run([
      sse({ calls: [{ id: 'c1', name: 'make_file', args: '{"format":' }] }),
      sse({ calls: [{ id: 'c2', name: 'make_file', args: '{"format":"pptx"}' }] }),
      sse({ calls: [{ id: 'c3', name: 'make_file', args: '{"format":"pptx"}' }] }),
      sse({ text: ['Done.'] }),
    ], async (_a, n) => { if (n === 1) throw new Error('disk full'); return { result: { content: [] } } })
    expect(r.calls).toHaveLength(2)
    const tools = r.bodies.slice(1).map((b) => b.messages.at(-1))
    expect(tools[0].content).toMatch(/not valid JSON/)
    expect(tools[1].content).toMatch(/Error: the tool failed: disk full/)
    // an empty result is not an empty message (some providers refuse that)
    expect(tools[2].content).toBe('(no output)')
    expect(r.events.filter((e) => e.type === 'tool_end').map((e) => (e as { ok: boolean }).ok)).toEqual([false, false, true])
    expect(r.events.at(-1)).toEqual({ type: 'done' })
  })
})

describe('grounded links (B-API-2)', () => {
  const real = fileShareUrl('people/alice/deck.pptx', 'preview')
  const madeUp = fileShareUrl('people/alice/deck-final.pptx', 'preview')

  test('the instructions ask for grounded answers, and a tool result names its links once more', async () => {
    const r = await run([
      sse({ calls: [{ id: 'c1', name: 'make_file', args: '{}' }] }),
      sse({ text: ['ok'] }),
    ], async () => ({ result: { content: [{ type: 'text', text: `Saved people/alice/deck.pptx. Link for the user: [deck.pptx](${real})` }] } }))
    expect(r.bodies[0].messages[0].content).toBe(`sys\n\n${API_GROUNDING_RULES}`)
    expect(API_GROUNDING_RULES).toMatch(/copying it exactly/)
    expect(API_GROUNDING_RULES).toMatch(/If you do not know, say so/)
    expect(r.bodies[1].messages.at(-1).content).toContain(`copy them exactly; there are no other links to these files):\n- ${real}`)
  })

  test('a team link that a tool gave stays, a made-up one becomes plain text, web links are not changed', async () => {
    const answer = `Here: [deck](${real}), also [final](${madeUp}) and ${madeUp}. Source: [report](https://example.org/a?b=1) and https://drive.google.com/x.`
    // in small pieces, so links arrive split across deltas
    const pieces = answer.match(/.{1,7}/gs)!
    const r = await run([
      sse({ calls: [{ id: 'c1', name: 'make_file', args: '{}' }] }),
      sse({ text: pieces }),
    ], async () => ({ result: { content: [{ type: 'text', text: `Saved. Link for the user: [deck.pptx](${real})` }] } }))
    expect(textOf(r.events)).toBe(`Here: [deck](${real}), also final and . Source: [report](https://example.org/a?b=1) and https://drive.google.com/x.`)
  })

  test('the same file in another encoding matches; links from the message (earlier answers) stay allowed', async () => {
    const plain = '/files/view?path=people/alice/deck.pptx'
    const old = fileShareUrl('people/alice/old.docx', 'download')
    const r = await run([sse({ text: [`[deck](${plain}) [old](${old})`] })], async () => ({ result: { content: [] } }), { systemPrompt: `history: [deck](${real})`, message: `send again: ${old}` })
    expect(textOf(r.events)).toBe(`[deck](${plain}) [old](${old})`)
  })

  test('absolute links: this server\'s addresses are checked, other hosts are not', () => {
    const g = new LinkGuard(['https://team.example.com'])
    g.allow(`[a](${real})`)
    expect(g.clean(`[a](https://team.example.com${real}) [b](https://team.example.com${madeUp}) [c](https://other.example${madeUp})`))
      .toBe(`[a](https://team.example.com${real}) b [c](https://other.example${madeUp})`)
  })

  test('file names with parentheses (conflict copies): the whole link is kept, allowed and checked', () => {
    const name = conflictCopyName('Report.pptx', 'Budi', new Date(2026, 9, 29, 9, 5))
    expect(name).toContain('(')
    const link = fileShareUrl(`docs/${name}`, 'preview')
    // no bare parenthesis in the canonical link
    expect(link).not.toMatch(/[()]/)
    const g = new LinkGuard()
    expect(g.allow(`Saved docs/${name}. Link for the user: [${name}](${link})`)).toEqual([link])
    // the same file, retyped with bare parentheses (encodeURIComponent form); and a made-up sibling
    const bare = `/files/view?path=${encodeURIComponent(`docs/${name}`)}`
    expect(bare).toMatch(/\(/)
    const madeUp = `/files/view?path=${encodeURIComponent('docs/Report (final).pptx')}`
    const answer = `Open [Report.pptx](${link}) or [it](${bare}) (also ${bare}). Not [this](${madeUp}) or ${madeUp}.`
    expect(g.clean(answer)).toBe(`Open [Report.pptx](${link}) or [it](${bare}) (also ${bare}). Not this or .`)
    // the same in small streamed pieces
    const s = new LinkGuard()
    s.allow(link)
    let out = ''
    for (const p of answer.match(/.{1,5}/gs)!) out += s.push(p)
    out += s.flush()
    expect(out).toBe(`Open [Report.pptx](${link}) or [it](${bare}) (also ${bare}). Not this or .`)
    // a tool output with bare parentheses is recorded whole, and a closing ')' after a bare URL is not part of it
    const t = new LinkGuard()
    expect(t.allow(`see (${bare})`)).toEqual([bare])
  })

  test('streaming: text without links passes unchanged, held text comes out at the end', () => {
    const g = new LinkGuard()
    let out = ''
    for (const p of ['See [1] and [', 'note', '] here', ' and a/b/c', ' path']) out += g.push(p)
    out += g.flush()
    expect(out).toBe('See [1] and [note] here and a/b/c path')
    // an open bracket that never closes is not held for ever
    const long = '[' + 'x '.repeat(1500)
    expect(g.push(long).length).toBeGreaterThan(2000)
    g.flush()
  })
})

describe('a chat turn with the api engine keeps only real team links', () => {
  let h: Harness
  let mock: ReturnType<typeof Bun.serve>
  const script: string[] = []
  const seen: any[] = []
  beforeAll(async () => {
    mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [] }); seen.push(await req.json()); return new Response(script.shift() ?? sse({ text: ['(no script)'] })) } })
    h = await startHarness({ name: 'api-grounding' })
    writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
    const confs = h.rt().engines.get()
    confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
    delete confs.problems.api
    setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  })
  afterAll(async () => { await h.close(); mock.stop(true) })

  test('share_file gives the link; an invented preview link is removed from the saved answer', async () => {
    const real = fileShareUrl('shared', 'preview')
    const madeUp = fileShareUrl('shared/report-final.pdf', 'preview')
    script.push(
      sse({ calls: [{ id: 'c1', name: 'share_file', args: JSON.stringify({ path: 'shared', mode: 'preview' }) }] }),
      sse({ text: [`Open [shared](${real}) or the [preview](`, `${madeUp}).`] }),
    )
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'link the shared folder', clientMessageId: `cm-${Date.now()}`, attachmentIds: [], engine: 'api' as EngineId } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 20_000 })
    const m = h.ctx.db.query('SELECT status, content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string; content: string }
    expect(m).toMatchObject({ status: 'done', content: `Open [shared](${real}) or the preview.` })
    // the model got the canonical link with the rule, and the grounding rules in its instructions
    expect(seen[1].messages.at(-1).content).toContain(`- ${real}`)
    expect(seen[0].messages[0].content).toContain('## Grounded answers')
  })

  test('share_file on a conflict copy (parentheses in the name): the real link stays whole in the answer', async () => {
    const name = conflictCopyName('Report.pptx', 'Budi', new Date(2026, 9, 29, 9, 5))
    mkdirSync(path.join(h.team, 'shared'), { recursive: true })
    writeFileSync(path.join(h.team, 'shared', name), 'x')
    const real = fileShareUrl(`shared/${name}`, 'preview')
    const madeUp = fileShareUrl('shared/Report (final).pptx', 'preview')
    const before = seen.length
    script.push(
      sse({ calls: [{ id: 'c1', name: 'share_file', args: JSON.stringify({ path: `shared/${name}`, mode: 'preview' }) }] }),
      sse({ text: [`Open [Report.pptx](${real.slice(0, 30)}`, `${real.slice(30)}) or [this](${madeUp}).`] }),
    )
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'link the copy', clientMessageId: `cm-${Date.now()}`, attachmentIds: [], engine: 'api' as EngineId } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 20_000 })
    const m = h.ctx.db.query('SELECT status, content FROM messages WHERE id = ?').get(r.assistantMessage.id) as { status: string; content: string }
    expect(m).toMatchObject({ status: 'done', content: `Open [Report.pptx](${real}) or this.` })
    expect(seen[before + 1].messages.at(-1).content).toContain(`copy them exactly; there are no other links to these files):\n- ${real}`)
  })
})
