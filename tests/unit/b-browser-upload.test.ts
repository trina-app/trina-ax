// file_upload on the server (docs/decisions/20261126-browser-file-upload.md), with the fake engine and a scripted
// desktop window: the tool exists only for a window whose desktop app said pane=1; the AI's team paths and chat files
// become single-use tickets (the person's own, the exact bytes checked, until the call ends); every failure of the
// download is the same 404; refusals send nothing to the desktop; a shared chat's file read card comes first for a
// team file some people there cannot open; an older desktop app's "Malformed browser call." becomes "update the app";
// the step and the audit line name the files.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { warnedIn } from '../lib/shared-warned'
import { BrowserUploads, MAX_PENDING_BYTES } from '../../server/src/realtime/browser-uploads'
import { BROWSER_NO_UPLOAD_RULE, BROWSER_UPLOAD_RULE } from '../../server/src/chat/prompt'
import { UPDATE_APP_TEXT } from '../../server/src/chat/browser-upload'
import { localizeStep } from '../../shared/src/step-labels'
import { keepBrowserWarnSeen } from '../../server/src/chat/browser-notice'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-upl-desk01'
const OLD = 'win-upl-old0001'
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

let h: Harness
let desk: TestSocket, old: TestSocket
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-browser-upload', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop', pane: 1 })
  await desk.next('hello')
  old = await h.ws('alice', { windowId: OLD, client: 'desktop' })
  await old.next('hello')
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { desk?.close(); old?.close(); await h?.close() })

type Got = { ticket: string; name: string; size: number; sha256: string; status: number; bytes?: Buffer; again?: number; bob?: number }
/** the desktop app: file_upload calls fetch every ticket (bob first, then alice twice), the rest answer "ok" */
function serve(sock: TestSocket, o: { answer?: (call: { tool: string; args: Record<string, unknown> }) => string | null } = {}) {
  // calls from before (an earlier test's) are not answered again
  const done = new Set<string>(sock.frames.filter((f) => f.type === 'browser.call').map((f) => f.data.call.callId))
  const got: Got[][] = []
  const timer = setInterval(() => {
    for (const f of sock.frames) {
      if (f.type !== 'browser.call' || done.has(f.data.call.callId)) continue
      const call = f.data.call
      done.add(call.callId)
      sock.send({ type: 'browser.ack', callId: call.callId })
      void (async () => {
        const custom = o.answer?.(call)
        if (custom) return sock.send({ type: 'browser.result', result: { callId: call.callId, ok: false, content: [{ type: 'text', text: custom }], error: custom } })
        if (call.tool !== 'file_upload') return sock.send({ type: 'browser.result', result: { callId: call.callId, ok: true, content: [{ type: 'text', text: 'ok' }] } })
        const files = (call.args.files as Got[]) ?? []
        const mine: Got[] = []
        for (const x of files) {
          const bob = (await h.req('bob', `/api/browser/uploads/${x.ticket}`)).status
          const r = await h.req('alice', `/api/browser/uploads/${x.ticket}`)
          const bytes = r.ok ? Buffer.from(await r.arrayBuffer()) : undefined
          const again = (await h.req('alice', `/api/browser/uploads/${x.ticket}`)).status
          mine.push({ ...x, status: r.status, bytes, again, bob, ...(r.ok ? {} : {}) })
          if (r.ok) expect(r.headers.get('cache-control')).toBe('no-store')
          if (r.ok) expect(r.headers.get('content-type')).toBe('application/octet-stream')
        }
        got.push(mine)
        sock.send({ type: 'browser.result', result: { callId: call.callId, ok: true, content: [{ type: 'text', text: `Attached ${files.length} file${files.length === 1 ? '' : 's'} to mail.example.com (${files.map((x) => x.name).join(', ')}) through the page's file field.` }] } })
      })()
    }
  }, 20)
  return { got, stop: () => clearInterval(timer) }
}

const fromDesk = (chatId: string, content: string, window = DESK, attachmentIds: string[] = []) =>
  h.api('alice', { window, client: 'desktop' }).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
const doneOn = async (sock: TestSocket, chatId: string, messageId: string) => {
  const d = await sock.next('message.done', (f) => f.data.messageId === messageId, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return d.data.message as Message
}
const uploadCalls = (sock: TestSocket) => sock.frames.filter((f) => f.type === 'browser.call' && f.data.call.tool === 'file_upload').length
const summary = (turnId: string, tool = 'file_upload') => (h.ctx.db.query('SELECT summary FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY id DESC').get(turnId, tool) as { summary: string } | null)?.summary ?? ''
const UPLOAD = (files: unknown, extra: Record<string, unknown> = {}) => fake({ tool: 'file_upload', args: { ref: 'ref_7', files, ...extra }, sayResult: true })
const teamBytes = (rel: string) => fs.readFileSync(path.join(h.team, rel))

describe('file_upload: offered only to a desktop app that runs it', () => {
  test('pane=1: listed, and the prompt says how to attach; an older app (no pane): not listed, and the prompt says to update it', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await fromDesk(chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { echo: 'system' }))
    const d = await doneOn(desk, chat.id, r.assistantMessage.id)
    const [tools, system] = d.content.split(' | ')
    expect(tools!.split(',')).toContain('file_upload')
    expect(system).toContain(BROWSER_UPLOAD_RULE)
    expect(system).not.toContain('It cannot attach a team file to a page')
    const r2 = await fromDesk(chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { echo: 'system' }), OLD)
    const d2 = await doneOn(old, chat.id, r2.assistantMessage.id)
    const [tools2, system2] = d2.content.split(' | ')
    expect(tools2!.split(',')).toContain('navigate')
    expect(tools2!.split(',')).not.toContain('file_upload')
    expect(system2).toContain(BROWSER_NO_UPLOAD_RULE)
  })

  test('the long-poll path says the version too (pane= on GET /api/browser/calls)', async () => {
    const W = 'win-upl-poll001'
    const ac = new AbortController()
    void h.api('alice', { window: W, client: 'desktop' }).call(API.pollCalls, { query: { windowId: W, waitMs: 1000, pane: 1 } }).catch(() => {})
    await Bun.sleep(50)
    expect(h.rt().relay.paneVersion('alice', W)).toBe(1)
    expect(h.rt().relay.paneVersion('alice', 'win-upl-nobody1')).toBe(0)
    expect(h.rt().relay.paneVersion('alice', DESK)).toBe(1)
    expect(h.rt().relay.paneVersion('alice', OLD)).toBe(0)
    ac.abort()
  })
})

describe('file_upload in the person\'s own chat', () => {
  test('team paths (plain and team-file:) and a chat path become tickets: the exact bytes once, never to another person, then 404; step and audit name the files', async () => {
    const s = serve(desk)
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await fromDesk(chat.id, UPLOAD(['shared/handbook.pdf', 'team-file:groups/marketing/campaign-brief.md']))
      const d = await doneOn(desk, chat.id, r.assistantMessage.id)
      expect(d.content).toContain('Attached 2 files to mail.example.com')
      const [a, b] = s.got.at(-1)!
      // the desktop never sees the team path, only the name, size, hash and a ticket
      const frame = desk.frames.filter((f) => f.type === 'browser.call' && f.data.call.tool === 'file_upload').at(-1)!
      const call = (frame as { data: { call: { args: Record<string, unknown> } } }).data.call
      expect(JSON.stringify(call.args)).not.toContain('shared/handbook.pdf')
      expect(call.args).toMatchObject({ ref: 'ref_7' })
      expect(a).toMatchObject({ name: 'handbook.pdf', status: 200, again: 404, bob: 404 })
      expect(b).toMatchObject({ name: 'campaign-brief.md', status: 200, again: 404, bob: 404 })
      expect(a!.bytes!.equals(teamBytes('shared/handbook.pdf'))).toBe(true)
      expect(sha(a!.bytes!)).toBe(a!.sha256)
      expect(a!.size).toBe(a!.bytes!.length)
      expect(a!.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const step = d.steps.find((x) => x.tool === 'file_upload')!
      expect(step.label).toBe('Files attached (2): mail.example.com · handbook.pdf, campaign-brief.md')
      expect(localizeStep(step, 'ko').label).toBe('파일 2개 첨부함: mail.example.com · handbook.pdf, campaign-brief.md')
      const sum = summary(r.turnId)
      expect(sum).toContain('2 files attached: shared/handbook.pdf ')
      expect(sum).toContain(`sha256 ${a!.sha256.slice(0, 16)}`)
      expect(sum).toContain('groups/marketing/campaign-brief.md')
      // the call is over: nothing waits
      expect(h.rt().relay.uploads.pendingBytes).toBe(0)
    } finally { s.stop() }
  })

  test('refusals send nothing to the desktop: a file the person cannot read, a folder, too many, the same file twice, a chat file that is not there, in a batch', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const cases: [unknown, string, string][] = [
      [['groups/finance/budget.md'], 'Nothing was attached: there is no team file "groups/finance/budget.md" that the user can read', 'attachment not found'],
      [['shared/policies'], 'is a folder; only a file can be attached', 'attachment is a folder'],
      [Array.from({ length: 21 }, (_, i) => `shared/x-${i}.md`), 'one call can attach at most 20 files', 'too many attachments'],
      [['shared/glossary.md', 'team-file:shared/glossary.md'], 'the same team file is named more than once', 'attachment named twice'],
      [['chat:files/nope.pdf'], 'no file "chat:files/nope.pdf" was sent in this chat', 'chat file not found'],
    ]
    for (const [files, said, sum] of cases) {
      const n = uploadCalls(desk)
      const r = await fromDesk(chat.id, UPLOAD(files))
      const d = await doneOn(desk, chat.id, r.assistantMessage.id)
      expect(d.content).toContain(said)
      expect(summary(r.turnId)).toContain(sum)
      expect(uploadCalls(desk)).toBe(n)
    }
    const n = desk.frames.filter((f) => f.type === 'browser.call').length
    const r = await fromDesk(chat.id, fake({ tool: 'browser_batch', args: { actions: [{ name: 'find', input: { query: 'x' } }, { name: 'file_upload', input: { ref: 'ref_1', files: ['shared/glossary.md'] } }] }, sayResult: true }))
    const d = await doneOn(desk, chat.id, r.assistantMessage.id)
    expect(d.content).toContain('file_upload cannot be part of browser_batch')
    expect(desk.frames.filter((f) => f.type === 'browser.call').length).toBe(n)
  })

  test('an older desktop app that still got the call ("Malformed browser call."): the AI is told to have the app updated', async () => {
    const s = serve(desk, { answer: (c) => (c.tool === 'file_upload' ? 'Malformed browser call.' : null) })
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const r = await fromDesk(chat.id, UPLOAD(['shared/glossary.md']))
      const d = await doneOn(desk, chat.id, r.assistantMessage.id)
      expect(d.content).toContain(UPDATE_APP_TEXT)
      expect(d.content).not.toContain('Malformed browser call.')
      expect(h.rt().relay.uploads.pendingBytes).toBe(0)
    } finally { s.stop() }
  })
})

describe('the download endpoint and its tickets', () => {
  const ticketFor = (o: { user?: string; recheck?: () => boolean; expiresAt?: number; bytes?: Buffer } = {}) =>
    h.rt().relay.uploads.issue([{ userId: o.user ?? 'alice', windowId: DESK, callId: 'c-' + crypto.randomUUID(), name: 'a.txt', bytes: o.bytes ?? Buffer.from('hello'), sha256: sha(Buffer.from('hello')), expiresAt: o.expiresAt ?? Date.now() + 60_000, recheck: o.recheck ?? (() => true) }])![0]!

  test('single use, the person\'s own (another person\'s try leaves it usable), access removed or expired: 404 alike; signed out: refused', async () => {
    const t = ticketFor()
    expect((await h.req('bob', `/api/browser/uploads/${t}`)).status).toBe(404)
    const r = await h.req('alice', `/api/browser/uploads/${t}`)
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('hello')
    expect((await h.req('alice', `/api/browser/uploads/${t}`)).status).toBe(404)
    // the person lost access (or the file changed) since it was checked: the recheck fails, the ticket is gone
    const gone = ticketFor({ recheck: () => false })
    expect((await h.req('alice', `/api/browser/uploads/${gone}`)).status).toBe(404)
    const throws = ticketFor({ recheck: () => { throw new Error('denied') } })
    expect((await h.req('alice', `/api/browser/uploads/${throws}`)).status).toBe(404)
    const expired = ticketFor({ expiresAt: Date.now() - 1 })
    expect((await h.req('alice', `/api/browser/uploads/${expired}`)).status).toBe(404)
    expect((await h.req('alice', '/api/browser/uploads/not-a-ticket')).status).toBe(404)
    const anon = ticketFor()
    expect((await fetch(`${h.url}/api/browser/uploads/${anon}`)).status).toBe(401)
  })

  test('tickets: revoked with their call, expired by the clock, and the whole server holds at most MAX_PENDING_BYTES', () => {
    let now = 1000
    const u = new BrowserUploads(() => now)
    const f = (callId: string, size: number, expiresAt = 5000) => ({ userId: 'alice', windowId: 'w', callId, name: 'x', bytes: Buffer.alloc(size), sha256: '0'.repeat(64), expiresAt, recheck: () => true })
    const [a] = u.issue([f('c1', 10)])!
    const [b] = u.issue([f('c2', 10)])!
    u.revokeCall('c1')
    expect(u.take(a!, 'alice')).toBeNull()
    now = 6000
    expect(u.take(b!, 'alice')).toBeNull()
    expect(u.pendingBytes).toBe(0)
    expect(u.issue([f('c3', MAX_PENDING_BYTES - 5, 99_999)])).not.toBeNull()
    expect(u.issue([f('c4', 10, 99_999)])).toBeNull()
    u.revokeCall('c3')
    expect(u.issue([f('c4', 10, 99_999)])).not.toBeNull()
  })
})

describe('file_upload in a shared project chat', () => {
  const card = (f: { data: { request: unknown } }) => f.data.request as { requestId: string; question: string; options: { label: string; value: string }[] }
  /** a turn whose cards are answered by `pick` until it ends */
  async function withCards(content: string, pick: (c: { question: string; options: { label: string; value: string }[] }) => string, o: { chat?: string; attachments?: string[] } = {}) {
    const chat = o.chat ? { id: o.chat } : await h.api('alice').call(API.createChat, { body: { projectId } })
    const place = o.chat ? `c:${chat.id}` : `p:${projectId}`
    warnedIn(h.ctx.db, place)
    keepBrowserWarnSeen(h.ctx.db, 'alice', place, null)
    const started = await fromDesk(chat.id, content, DESK, o.attachments)
    const seen = new Set<string>()
    const cards: { question: string; options: { label: string; value: string }[] }[] = []
    const timer = setInterval(() => {
      for (const f of desk.frames) {
        if (f.type !== 'turn.request' || f.data.turnId !== started.turnId) continue
        const c = card(f)
        if (seen.has(c.requestId)) continue
        seen.add(c.requestId)
        cards.push(c)
        void h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: pick(c) } }).catch(() => {})
      }
    }, 20)
    try { return { started, cards, done: await doneOn(desk, chat.id, started.assistantMessage.id) } } finally { clearInterval(timer) }
  }
  const pickBrowser = (c: { question: string; options: { value: string }[] }, file: string) => (c.question.includes('can also see what the AI gets from your browser') ? c.options[0]!.value : file)

  test('a file everyone here can open: no file read card, attached', async () => {
    const s = serve(desk)
    try {
      const n = uploadCalls(desk)
      const r = await withCards(UPLOAD(['projects/falcon/plan.md']), (c) => pickBrowser(c, 'allow'))
      expect(r.cards.filter((c) => !c.question.includes('your browser'))).toEqual([])
      expect(uploadCalls(desk)).toBe(n + 1)
      expect(r.done.content).toContain('Attached 1 file to mail.example.com')
    } finally { s.stop() }
  })

  test('a file bob cannot open: alice\'s file read card first; no attaches nothing and says so plainly; yes attaches', async () => {
    const s = serve(desk)
    try {
      const n = uploadCalls(desk)
      const no = await withCards(UPLOAD(['groups/marketing/campaign-brief.md']), (c) => pickBrowser(c, c.options.some((o) => o.value === 'skip') ? 'skip' : c.options.at(-1)!.value))
      const read = no.cards.filter((c) => !c.question.includes('your browser'))
      expect(read.length).toBe(1)
      expect(read[0]!.options.map((o) => o.value)).toContain('share')
      expect(uploadCalls(desk)).toBe(n)
      expect(no.done.content).toContain('Nothing was sent: the team file named in this call was not attached.')
      expect(summary(no.started.turnId)).toContain('not attached (shared chat: file read card)')
      const yes = await withCards(UPLOAD(['groups/marketing/campaign-brief.md']), (c) => pickBrowser(c, c.options.some((o) => o.value === 'share') ? 'share' : c.options[0]!.value))
      expect(uploadCalls(desk)).toBe(n + 1)
      expect(yes.done.content).toContain('Attached 1 file to mail.example.com')
      expect(s.got.at(-1)![0]).toMatchObject({ name: 'campaign-brief.md', status: 200 })
    } finally { s.stop() }
  })

  test('a file sent in a chat shared with people (chat:files/<name>): its bytes, no file read card (everyone here has it)', async () => {
    const s = serve(desk)
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      await doneOn(desk, chat.id, (await fromDesk(chat.id, fake({ say: 'hi' }))).assistantMessage.id)
      const put = (confirmKey?: string) => h.api('alice').call(API.putChatAudience, { params: { id: chat.id }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }], ...(confirmKey ? { confirmKey } : {}) } })
      let shared = await put()
      if (shared.status === 'confirm') shared = await put(shared.confirmKey)
      expect(shared.status).toBe('saved')
      const bytes = Buffer.from('%PDF-1.4 business registration\n')
      const up = new FormData(); up.set('chatId', chat.id); up.set('file', new File([bytes], '사업자등록증.pdf'))
      const att = (await (await h.req('alice', '/api/uploads', { method: 'POST', body: up })).json()) as { id: string }
      await withCards(`the registration\n${fake({ say: 'ok' })}`, (c) => pickBrowser(c, 'allow'), { chat: chat.id, attachments: [att.id] })
      const r = await withCards(UPLOAD(['chat:files/사업자등록증.pdf', 'shared/glossary.md']), (c) => pickBrowser(c, 'allow'), { chat: chat.id })
      expect(r.done.content).toContain('Attached 2 files')
      expect(r.cards.filter((c) => !c.question.includes('your browser'))).toEqual([])
      const [a, b] = s.got.at(-1)!
      expect(a).toMatchObject({ name: '사업자등록증.pdf', status: 200, again: 404, bob: 404 })
      expect(a!.bytes!.equals(bytes)).toBe(true)
      expect(b).toMatchObject({ name: 'glossary.md', status: 200 })
      expect(summary(r.started.turnId)).toContain('chat:files/사업자등록증.pdf')
    } finally { s.stop() }
  })
})
