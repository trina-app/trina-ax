// Regression tests for team files attached to chats by reference (POST /api/attachments/team-file, GET
// /api/files/find, GET /api/files/recent, the thumbnail of a reference, message history and realtime copies).
// The owner's #1 requirement: nobody learns anything outside their permissions — not a file's existence, name, size
// or content — through attaching, the picker, a message that refers to a file, or the AI's turn.
// Same isolated instance + world as the permission matrix (tests/security/lib).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { startInstance, type Client, type Instance } from './lib/instance'
import { buildWorld, C, type World } from './lib/world'

setDefaultTimeout(180_000)
let W: World
let inst: Instance
beforeAll(async () => { inst = await startInstance('attach-team-files'); W = await buildWorld(inst) })
afterAll(async () => { for (const s of Object.values(W?.sockets ?? {})) s.close(); await inst?.close() })

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const norm = (t: string) => t.replace(/"requestId":"[^"]*"/, '"requestId":"-"')
const ownChat = async (c: Client) => (await c.ok('POST', '/api/chats', { title: 'attach sec' })).id as string
const attach = (c: Client, chatId: string, path: string) => c.post('/api/attachments/team-file', { chatId, path })

describe('attach: refused exactly like a file that does not exist', () => {
  test('every persona, every out-of-reach path: the same 404 body as a missing file, no canary', async () => {
    const { finFolder, mktFolder } = W.groups
    const targets: Record<string, string[]> = {
      // alice: finance, the hidden salaries folder under her own group
      memberIn: [`${finFolder}/budget.md`, `${finFolder}/${C.finName}.md`, `${mktFolder}/salaries/2026.md`, 'users/bob/notes.md', '.system', '.system/trash'],
      // erin (marketing too): alice's personal files, finance, salaries
      other: ['users/alice/todo.md', `users/alice/${C.aliceFileName}.md`, `${finFolder}/budget.md`, `${mktFolder}/salaries/2026.md`, 'projects/falcon/plan.md'],
      // bob: alice's folder, marketing
      memberOut: ['users/alice/todo.md', `${mktFolder}/brief.md`, `${mktFolder}/salaries/2026.md`],
      // owner and admin: never another person's personal folder or the server folder
      owner: ['users/alice/todo.md', `users/alice/${C.aliceFileName}.md`, 'users/bob/notes.md', '.system', '.system/trash'],
      admin: ['users/alice/todo.md', 'users/bob/notes.md', '.system/trash'],
    }
    for (const [who, paths] of Object.entries(targets)) {
      const c = W.as[who as keyof typeof W.as]
      const chat = await ownChat(c)
      const missing = await attach(c, chat, 'shared/no-such-file-here.md')
      expect(missing.status).toBe(404)
      const base = norm(missing.text)
      for (const p of paths) {
        const r = await attach(c, chat, p)
        expect({ who, p, status: r.status, body: norm(r.text) }).toEqual({ who, p, status: 404, body: base })
        // a case / Unicode look-alike of the same hidden path is no different
        const look = await attach(c, chat, p.toUpperCase())
        expect({ who, p: p.toUpperCase(), status: look.status, body: norm(look.text) }).toEqual({ who, p: p.toUpperCase(), status: 404, body: base })
      }
      // path tricks never reach the file system as written
      for (const p of ['../etc/passwd', '/etc/passwd', 'shared/../users/alice/todo.md', 'shared//x.md', 'shared/./x.md', 'users\\alice\\todo.md']) {
        const r = await attach(c, chat, p)
        expect(r.status, `${who} ${p}`).toBeGreaterThanOrEqual(400)
        expect(r.status, `${who} ${p}`).toBeLessThan(500)
        for (const x of [C.aliceFile, C.aliceFileName, C.finFile, C.salary, C.bobFile]) expect(r.text).not.toContain(x)
      }
    }
  })

  test("a chat that is not the caller's: refused without looking at the file", async () => {
    const r = await attach(W.as.memberOut, W.ids.chatA, 'shared/readme.md')
    expect(r.status).toBe(404)
    expect(r.text).not.toContain(C.aliceChatTitle)
  })
})

describe('picker listings never list what the caller cannot read', () => {
  test('find: finance names only for finance, alice names only for alice', async () => {
    const find = async (c: Client, q: string) => (await c.ok('GET', `/api/files/find?q=${encodeURIComponent(q)}&limit=100`)).items.map((i: { path: string }) => i.path) as string[]
    expect(await find(W.as.memberIn, 'SEC-FIN')).toEqual([])
    expect((await find(W.as.memberOut, 'SEC-FIN')).length).toBeGreaterThan(0)
    for (const who of ['owner', 'admin', 'other', 'memberOut'] as const) expect(await find(W.as[who], 'SEC-ALICE')).toEqual([])
    expect(await find(W.as.memberIn, '2026')).not.toContain(`${W.groups.mktFolder}/salaries/2026.md`)
    expect((await find(W.as.owner, '2026'))).toContain(`${W.groups.mktFolder}/salaries/2026.md`)
    // a folder the caller cannot list: "not found", not an empty list that would confirm it exists
    expect((await W.as.memberIn.get(`/api/files/find?q=budget&path=${encodeURIComponent(W.groups.finFolder)}`)).status).toBe(404)
  })
})

describe('a message that refers to a file', () => {
  test('after the person loses access: history, search, thumbnail and resend show nothing about the file', async () => {
    const alice = W.as.memberIn
    // a marketing file with a name only marketing can know
    const secret = `${W.groups.mktFolder}/SEC-MKT-ATTACHNAME-61f.png`
    await alice.ok('POST', '/api/files/upload', undefined, { form: (() => { const f = new FormData(); f.set('folder', W.groups.mktFolder); f.set('name', 'SEC-MKT-ATTACHNAME-61f.png'); f.set('file', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], 'x.png', { type: 'image/png' })); return f })() })
    const chat = await ownChat(alice)
    const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: secret })
    expect(ref).toMatchObject({ source: 'team', path: secret })
    expect((await alice.get(`/api/uploads/${ref.id}/thumbnail`)).status).toBe(200)
    // (the upload itself was announced to the people who can read marketing: carol, dana, erin)
    const mark = Object.fromEntries((['bob', 'carol', 'dana', 'erin'] as const).map((s) => [s, W.sockets[s].raw.length]))
    const sent = await alice.ok('POST', `/api/chats/${chat}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: fake({ say: 'seen' }) })
    await W.sockets.alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    // nobody else hears about the message or its attachment; bob never heard of the file at all
    expect(W.sockets.bob.all().includes('SEC-MKT-ATTACHNAME-61f'), 'bob heard the attached name').toBe(false)
    for (const s of ['carol', 'dana', 'erin'] as const) expect(W.sockets[s].raw.slice(mark[s]).join('\n').includes(ref.id), `${s} heard about alice's message`).toBe(false)
    // alice leaves marketing
    await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['erin'] })
    try {
      const msgs = await alice.get(`/api/chats/${chat}/messages`)
      expect(msgs.status).toBe(200)
      expect(msgs.text).not.toContain('SEC-MKT-ATTACHNAME-61f')
      expect(msgs.text).not.toContain(W.groups.mktFolder)
      const att = msgs.json.items.find((m: { role: string }) => m.role === 'user').attachments[0]
      expect(att).toMatchObject({ id: ref.id, unavailable: true, name: '', path: '', size: 0 })
      expect(att.sha256).toBeUndefined()
      expect((await alice.get(`/api/uploads/${ref.id}/thumbnail`)).status).toBe(404)
      const again = await alice.post(`/api/chats/${chat}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: 'again' })
      expect(again.status).toBe(400)
      expect(again.text).not.toContain('SEC-MKT-ATTACHNAME-61f')
      const search = await alice.get('/api/chats?q=SEC-MKT-ATTACHNAME')
      expect(search.text).not.toContain('SEC-MKT-ATTACHNAME-61f')
      const chats = await alice.get('/api/chats')
      expect(chats.text).not.toContain('SEC-MKT-ATTACHNAME-61f') // the title never takes a team file's name
      // the next turn on that message: the engine is told only that a file is unavailable
      const regen = await alice.ok('POST', `/api/chats/${chat}/messages/${sent.assistantMessage.id}/regenerate`, {})
      const done = await W.sockets.alice.next('message.done', (f) => f.data.messageId === regen.assistantMessage.id, 30_000)
      expect(JSON.stringify(done.data.message)).not.toContain('SEC-MKT-ATTACHNAME-61f')
    } finally {
      await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['alice', 'erin'] })
    }
  })

  test("someone else's reference id is useless: not sendable, no thumbnail, nothing in the error", async () => {
    const alice = W.as.memberIn
    const chat = await ownChat(alice)
    const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: `users/alice/${C.aliceFileName}.md` })
    for (const who of ['other', 'memberOut', 'owner', 'admin'] as const) {
      const c = W.as[who]
      const mine = await ownChat(c)
      const r = await c.post(`/api/chats/${mine}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: 'x' })
      expect(r.status, who).toBe(400)
      expect(r.text).not.toContain(C.aliceFileName)
      const t = await c.get(`/api/uploads/${ref.id}/thumbnail`)
      expect(t.status, who).toBe(404)
    }
  })

  test("the audit list and usage never show the name of a personal file someone attached", async () => {
    const alice = W.as.memberIn
    const chat = await ownChat(alice)
    const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: `users/alice/${C.aliceFileName}.md` })
    const sent = await alice.ok('POST', `/api/chats/${chat}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: fake({ tool: 'read', args: { file_path: `users/alice/${C.aliceFileName}.md` } }, { say: 'done' }) })
    await W.sockets.alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    for (const who of ['owner', 'admin'] as const) {
      for (const p of ['/api/admin/audit?limit=200', '/api/admin/usage']) {
        const r = await W.as[who].get(p)
        expect(r.text.includes(C.aliceFileName), `${who} ${p}`).toBe(false)
      }
    }
  })
})

describe('review regressions', () => {
  // attack review #3: a step "Attached file moved · <new path>" kept the new name after the person lost access
  test('a step about an attached file shows no path once the person cannot open the file', async () => {
    const alice = W.as.memberIn
    const mkt = W.groups.mktFolder
    await alice.ok('PUT', '/api/files/content', { path: `${mkt}/brief-v1-sec.md`, content: 'brief\n', baseSha256: null })
    const chat = await ownChat(alice)
    const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: `${mkt}/brief-v1-sec.md` })
    const sent = await alice.ok('POST', `/api/chats/${chat}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: fake({ say: 'ok' }) })
    await W.sockets.alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    await W.as.owner.ok('POST', '/api/files/move', { from: `${mkt}/brief-v1-sec.md`, to: `${mkt}/SEC-LAYOFF-PLAN-NAME.md`, onExists: 'fail', confirm: false })
    const regen = await alice.ok('POST', `/api/chats/${chat}/messages/${sent.assistantMessage.id}/regenerate`, {})
    const done = await W.sockets.alice.next('message.done', (f) => f.data.messageId === regen.assistantMessage.id, 30_000)
    expect(JSON.stringify(done.data.message.steps)).toContain('SEC-LAYOFF-PLAN-NAME') // she could open it then
    await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['erin'] })
    try {
      const msgs = await alice.get(`/api/chats/${chat}/messages`)
      expect(msgs.status).toBe(200)
      expect(msgs.text).not.toContain('SEC-LAYOFF-PLAN-NAME')
      expect(msgs.text).not.toContain('brief-v1-sec')
      const step = msgs.json.items.find((m: { id: string }) => m.id === regen.assistantMessage.id).steps.find((s: { tool?: string }) => s.tool === 'attachment')
      expect(step).toMatchObject({ label: 'An attached team file is no longer available', status: 'ok' })
    } finally {
      await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['alice', 'erin'] })
    }
  })

  // UX review #2: sending after access was taken away must say so (and let the web send without it) without telling
  // anything about the file, and never confirm someone else's reference id
  test('send after access is lost: only the sender\'s own ids are named, nothing about the file', async () => {
    const alice = W.as.memberIn
    const mkt = W.groups.mktFolder
    await alice.ok('PUT', '/api/files/content', { path: `${mkt}/SEC-SEND-LOST-71.md`, content: 'x\n', baseSha256: null })
    const chat = await ownChat(alice)
    const ref = await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: `${mkt}/SEC-SEND-LOST-71.md` })
    await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['erin'] })
    try {
      const r = await alice.post(`/api/chats/${chat}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: 'x' })
      expect(r.status).toBe(400)
      expect(r.json.error.params).toEqual({ reason: 'team_files_unavailable', ids: ref.id })
      expect(r.text).not.toContain('SEC-SEND-LOST-71')
      expect(r.text).not.toContain(mkt)
      // erin (still in marketing) aims alice's id at her own chat: the general answer, the id is not confirmed
      const erinChat = await ownChat(W.as.other)
      const e = await W.as.other.post(`/api/chats/${erinChat}/messages`, { clientMessageId: cm(), attachmentIds: [ref.id], content: 'x' })
      expect(e.status).toBe(400)
      expect(e.json.error.params).toBeUndefined()
      expect(e.text).not.toContain('SEC-SEND-LOST-71')
    } finally {
      await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['alice', 'erin'] })
    }
  })

  test('attaching is audited, and a personal file attached shows to the owner and admin only as users/<id>/…', async () => {
    const alice = W.as.memberIn
    const chat = await ownChat(alice)
    await alice.ok('POST', '/api/attachments/team-file', { chatId: chat, path: `users/alice/${C.aliceFileName}.md` })
    for (const who of ['owner', 'admin'] as const) {
      const r = await W.as[who].ok('GET', '/api/admin/audit?limit=200')
      const mine = r.items.filter((i: { action: string }) => i.action === 'file.attach')
      expect(mine.length, who).toBeGreaterThan(0)
      expect(JSON.stringify(mine)).not.toContain(C.aliceFileName)
    }
  })
})
