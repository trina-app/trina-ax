// Component B: the in-app browser relay. Browser tools exist only for a message sent from a connected desktop
// window; calls go to that window only (WebSocket or long-poll), results come back once; office-network addresses
// need the person's OK; shared screenshots land in the chat attachment folder; a window that stays away fails the call.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { hostOf, isPrivateHost, privateIp } from '../../server/src/realtime/private-net'
import { urlsOf } from '../../server/src/realtime/browser-tools'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-desk-0001'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex').toString('base64')

let h: Harness
let desk: TestSocket
let web: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-browser', askUserTimeoutMs: 5000, relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
  web = await h.ws('alice', { windowId: 'win-web-00001' })
  await web.next('hello')
})
afterAll(async () => { desk?.close(); web?.close(); await h.close() })

/** the desktop app: answer browser.call frames with a scripted result */
function serve(sock: TestSocket, answer: (call: { callId: string; tool: string; args: Record<string, unknown> }) => unknown) {
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const f of sock.frames) {
      if (f.type !== 'browser.call' || done.has(f.data.call.callId)) continue
      done.add(f.data.call.callId)
      sock.send({ type: 'browser.ack', callId: f.data.call.callId })
      const r = answer(f.data.call)
      if (r) sock.send({ type: 'browser.result', result: r })
    }
  }, 20)
  return () => clearInterval(timer)
}

const send = (content: string, o: { window?: string; client?: 'desktop' | 'web' } = { window: DESK, client: 'desktop' }) => async (chatId: string) =>
  h.api('alice', o).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })

describe('browser tools', () => {
  test('desktop window: browser tools offered, the call reaches only that window, the result comes back once', async () => {
    const stop = serve(desk, (c) => ({ callId: c.callId, ok: true, content: [{ type: 'text', text: `opened ${c.args.url}` }] }))
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await send(fake({ echo: 'tools' }, { say: ' | ' }, { tool: 'navigate', args: { url: 'https://example.com' }, sayResult: true }, { say: ' | ' }, { echo: 'system' }))(chat.id)
      const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      const [tools, result, system] = d.data.message.content.split(' | ').map((x) => x.trim())
      for (const t of ['navigate', 'computer', 'read_page', 'browser_batch', 'preview_start', 'tabs_context']) expect(tools!.split(',')).toContain(t)
      expect(result).toBe('opened https://example.com')
      expect(system).toContain('## Browser (desktop app)')
      expect(d.data.message.steps.find((s) => s.tool === 'navigate')).toMatchObject({ kind: 'browser', label: 'Open page · https://example.com', status: 'ok' })
      expect(web.frames.some((f) => f.type === 'browser.call')).toBe(false)
    } finally { stop() }
  })

  test('a web window gets no browser tools; a desktop message without a connected window neither', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await send(fake({ echo: 'tools' }), { window: 'win-web-00001', client: 'web' })(chat.id)
    const d = await web.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    // file tools, B's tools and C's registered tools (make_file, share_file, artifact, web_fetch, search, schedule_*); no browser tools
    expect(d.data.message.content).toBe('artifact,ask_user,edit,forget,glob,grep,list,make_file,read,remember,schedule_create,schedule_delete,schedule_list,search,share_file,web_fetch,write')
    const r2 = await send(fake({ echo: 'tools' }), { window: 'win-desk-gone1', client: 'desktop' })(chat.id)
    const d2 = await web.next('message.done', (f) => f.data.messageId === r2.assistantMessage.id, 20_000)
    expect(d2.data.message.content).not.toContain('navigate')
  })

  test('office-network address: the sending window is asked; "always" is remembered, "deny" stops the call', async () => {
    const stop = serve(desk, (c) => ({ callId: c.callId, ok: true, content: [{ type: 'text', text: 'intranet page' }] }))
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await send(fake({ tool: 'navigate', args: { url: 'http://192.168.10.5/wiki' }, sayResult: true }))(chat.id)
      const card = await desk.next('turn.request', (f) => f.data.turnId === r.turnId)
      expect(card.data.request).toMatchObject({ kind: 'browser_site', host: '192.168.10.5' })
      expect(web.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.turnId)).toBe(false)
      // listed for the desktop window only
      expect((await h.api('alice', { window: DESK }).call(API.listTurnRequests, { params: { id: chat.id } })).items.length).toBe(1)
      expect((await h.api('alice', { window: 'win-web-00001' }).call(API.listTurnRequests, { params: { id: chat.id } })).items.length).toBe(0)
      // the wrong kind of answer does not count
      const wrong = await h.req('alice', `/api/turns/${r.turnId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'ask_user', requestId: card.data.request.requestId, answer: 'x' }) })
      expect(wrong.status).toBe(409)
      await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'browser_site', requestId: card.data.request.requestId, decision: 'always' } })
      const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(d.data.message.content).toBe('intranet page')
      expect(h.ctx.db.query("SELECT host FROM browser_site_grants WHERE user_id = 'alice'").all()).toEqual([{ host: '192.168.10.5' }])
      // granted: no card the second time
      const r2 = await send(fake({ tool: 'navigate', args: { url: 'http://192.168.10.5/other' }, sayResult: true }))(chat.id)
      const d2 = await desk.next('message.done', (f) => f.data.messageId === r2.assistantMessage.id, 20_000)
      expect(d2.data.message.content).toBe('intranet page')
      expect(desk.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === r2.turnId).length).toBe(0)
      // another private host, denied
      const r3 = await send(fake({ tool: 'browser_batch', args: { actions: [{ name: 'navigate', input: { url: 'intranet.corp' } }] }, sayResult: true }))(chat.id)
      const card3 = await desk.next('turn.request', (f) => f.data.turnId === r3.turnId)
      expect(card3.data.request).toMatchObject({ kind: 'browser_site', host: 'intranet.corp' })
      await h.api('alice').call(API.answerTurn, { params: { id: r3.turnId }, body: { kind: 'browser_site', requestId: card3.data.request.requestId, decision: 'deny' } })
      const d3 = await desk.next('message.done', (f) => f.data.messageId === r3.assistantMessage.id, 20_000)
      expect(d3.data.message.content).toContain('did not allow opening intranet.corp')
    } finally { stop() }
  })

  test('shared screenshot: saved in the chat attachment folder, shown under the step, image goes to the engine', async () => {
    const stop = serve(desk, (c) => ({ callId: c.callId, ok: true, content: [{ type: 'image', mime: 'image/png', data: PNG, shareToChat: true }] }))
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await send(fake({ tool: 'computer', args: { action: 'screenshot', save_to_disk: true } }, { say: 'shot' }))(chat.id)
      const d = await desk.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      const step = d.data.message.steps.find((s) => s.tool === 'computer')!
      expect(step.images?.length).toBe(1)
      const p = step.images![0]!.path
      expect(p).toStartWith(`users/alice/.attachments/${chat.id}/screenshot-`)
      expect(fs.readFileSync(path.join(h.team, p)).toString('base64')).toBe(PNG)
      expect(d.data.message.files).toBeNull() // not a "changed file" of the turn
    } finally { stop() }
  })

  test('long-poll fallback: a polling window gets the call and posts the result', async () => {
    const W = 'win-poll-0001'
    const api = h.api('alice', { window: W, client: 'desktop' })
    let polling = true
    const results: string[] = []
    const loop = (async () => {
      while (polling) {
        const r = await api.call(API.pollCalls, { query: { windowId: W, waitMs: 1000 } })
        for (const c of r.calls) {
          if (results.includes(c.callId)) continue
          results.push(c.callId)
          await api.call(API.postResult, { body: { callId: c.callId, ok: true, content: [{ type: 'text', text: `polled ${c.tool}` }] } })
        }
      }
    })()
    try {
      await Bun.sleep(100)
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await send(fake({ tool: 'read_page', args: {}, sayResult: true }), { window: W, client: 'desktop' })(chat.id)
      const d = await web.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
      expect(d.data.message.content).toBe('polled read_page')
      expect(results.length).toBe(1)
      // a result for an unknown / foreign call is refused
      const bad = await h.req('bob', '/api/browser/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: results[0], ok: true, content: [] }) })
      expect(bad.status).toBe(404)
    } finally { polling = false; await loop }
  })

  test('the window goes away during a call: browser_unavailable after the grace period; stop cancels open calls', async () => {
    const W = 'win-desk-0002'
    const d2 = await h.ws('alice', { windowId: W, client: 'desktop' })
    await d2.next('hello')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await send(fake({ tool: 'get_page_text', args: {}, sayResult: true }), { window: W, client: 'desktop' })(chat.id)
    await d2.next('browser.call')
    d2.close()
    const d = await web.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toContain('browser_unavailable')

    const d3 = await h.ws('alice', { windowId: W, client: 'desktop' })
    await d3.next('hello')
    const r2 = await send(fake({ tool: 'get_page_text', args: {}, sayResult: true }), { window: W, client: 'desktop' })(chat.id)
    const call = await d3.next('browser.call')
    await h.api('alice').call(API.stop, { params: { id: chat.id } })
    await d3.next('browser.cancel', (f) => f.data.callId === call.data.call.callId)
    const done = await web.next('message.done', (f) => f.data.messageId === r2.assistantMessage.id, 20_000)
    expect(done.data.status).toBe('stopped')
    d3.close()
  })

  test('a call is sent again when its window reconnects (deduped by callId on the window)', async () => {
    const W = 'win-desk-0003'
    const s1 = await h.ws('alice', { windowId: W, client: 'desktop' })
    await s1.next('hello')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await send(fake({ tool: 'find', args: { query: 'Sign in' }, sayResult: true }), { window: W, client: 'desktop' })(chat.id)
    const first = await s1.next('browser.call')
    s1.close()
    await s1.closedWith()
    const s2 = await h.ws('alice', { windowId: W, client: 'desktop' })
    const again = await s2.next('browser.call', (f) => f.data.call.callId === first.data.call.callId)
    s2.send({ type: 'browser.result', result: { callId: again.data.call.callId, ok: true, content: [{ type: 'text', text: 'ref_3' }] } })
    s2.send({ type: 'browser.result', result: { callId: again.data.call.callId, ok: true, content: [{ type: 'text', text: 'duplicate' }] } })
    const d = await web.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(d.data.message.content).toBe('ref_3')
    s2.close()
  })
})

describe('office-network check', () => {
  test('private IPs and local names', async () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(privateIp(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(privateIp(ip), ip).toBe(false)
    expect(hostOf('example.com/path')).toBe('example.com')
    expect(hostOf('http://[fd00::1]:8080/')).toBe('fd00::1')
    expect(hostOf('javascript:alert(1)')).toBeNull()
    const resolve = async (h: string) => (h === 'wiki.acme.com' ? ['10.0.0.8'] : ['93.184.215.14'])
    expect(await isPrivateHost('wiki.acme.com', resolve)).toBe(true)
    expect(await isPrivateHost('example.com', resolve)).toBe(false)
    for (const n of ['localhost', 'printer', 'nas.local', 'jira.internal', 'x.home.arpa']) expect(await isPrivateHost(n, resolve), n).toBe(true)
    expect(urlsOf('browser_batch', { actions: [{ name: 'navigate', input: { url: 'a.com' } }, { name: 'computer', input: { action: 'screenshot' } }, { name: 'navigate', input: { url: 'back' } }] })).toEqual(['a.com'])
    expect(urlsOf('preview_start', { url: 'https://b.com' })).toEqual(['https://b.com'])
  })
})
