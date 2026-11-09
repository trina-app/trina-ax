// A Hangul file sent in a room gets the HWP preview (docs/DECISIONS.md "대화방의 한글 파일 미리보기"):
// GET /api/rooms/:id/files/:fileId/hwp-preview, through the team file preview's renderer, cache and limits
// (files/hwp-preview.ts), with the checks of reading the room file inline (rooms/files.ts hwpSource) on every request
// and again after the render. A fake engine stands in for the HWP Preview plugin's renderer (the real one:
// tests/unit/hwp-preview.test.ts); without it the plugin is off here, as on a server that has not added it.
// Covered: a member gets pages (no browser cache, a cache hit by its id, a guessed id refused); not a member, an admin
// outside the room, another room's address and no session are refused; my own upload before it is sent is mine only; a
// hidden old answer's file, another person's private preview's file and a deleted message's file are refused; someone
// who joined after the message, someone who left after a page was cached and an archived room are refused, a cached
// page's id too; a file on the download-only list is refused before the renderer, also after a page of it was cached; a
// message deleted during the render gives no page; bytes changed on disk, a hard link and a symbolic link are refused;
// one render per person across team and room previews; over 20 MB is "limit" before any read; not a Hangul file is
// "unsupported"; the plugin off answers "disabled" for a room file and a team file alike, outsiders still 404 and a
// held file still "quarantined", and Me.server.hwpPreview follows the plugin; a team file's preview still works.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newId } from '../../server/src/db'
import { HwpPreviews } from '../../server/src/files/hwp-preview'
import type { HwpEngine } from '../../server/src/files/hwp-engine'
import { sha256 } from '../../server/src/files/store'
import { pluginsOf } from '../../server/src/plugins/manager'
import { componentC } from '../../server/src/team-files/component'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dir, '../fixtures/hwp', name))
const cm = () => 'cm-' + crypto.randomUUID()

/** the renderer's stand-in: a page per call, counted; `hook` holds a render open */
function fake(hook?: () => Promise<void>): HwpEngine & { calls: number } {
  return {
    identity: 'fake-room-hwp', calls: 0,
    async render(b, _ext, page) {
      this.calls++
      await hook?.()
      return { bytes: Buffer.from(`png page ${page}`), meta: { page, pageCount: 2, width: 100, height: 200, sourceHash: sha256(b), engine: 'fake', fonts: 'fake', warnings: ['layout_approximation'] } }
    },
  }
}

let h: Harness
let owner: Client
let ada: { client: Client; id: string }, mia: { client: Client; id: string }, nora: { client: Client; id: string }, otto: { client: Client; id: string }
let dm: { id: string }
let team: { id: string }
let plugged: HwpPreviews
beforeAll(async () => {
  h = await harness('b-rooms-hwp-preview')
  owner = await withOwner(h)
  ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  mia = await addMember(h, owner, { username: 'mia' })
  nora = await addMember(h, owner, { username: 'nora' })
  otto = await addMember(h, owner, { username: 'otto' })
  await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  team = ((await mia.client.call('GET', '/api/rooms')).items as { id: string; kind: string }[]).find((r) => r.kind === 'team')!
  // the HWP Preview plugin's renderer as the server resolves it (none installed here: off)
  plugged = componentC(h.ctx).hwp
})
afterAll(async () => { await h?.close() })

const useEngine = (e: HwpEngine) => { const c = componentC(h.ctx); c.hwp = new HwpPreviews(c.files, e) }
async function upload(by: Client, roomId: string, name: string, bytes: Uint8Array) {
  const form = new FormData()
  form.set('file', new File([bytes as BlobPart], name))
  const r = await h.fetch(`/api/rooms/${roomId}/files`, { method: 'POST', body: form, headers: { cookie: by.cookie!, 'x-mycel-csrf': '1' } })
  expect(r.status).toBe(201)
  return (await r.json()) as { id: string; name: string }
}
const send = (by: Client, roomId: string, fileIds: string[]) => by.call('POST', `/api/rooms/${roomId}/messages`, { body: '', fileIds, clientMessageId: cm() })
const preview = (c: Client | null, roomId: string, fileId: string, q = 'page=1') =>
  h.fetch(`/api/rooms/${roomId}/files/${fileId}/hwp-preview?${q}`, { headers: c ? { cookie: c.cookie! } : {} })
async function sentHwp(name = 'acme-form.hwp', bytes: Uint8Array = fixture('agreement.hwp'), roomId = dm.id) {
  const f = await upload(mia.client, roomId, name, bytes)
  const m = await send(mia.client, roomId, [f.id])
  return { file: f, message: m as { id: string } }
}
/** a row written straight into the room, with an upload of mia's attached to it (an AI answer: asked by mia) */
function putWithFile(roomId: string, fileId: string, o: { privateTo?: string } = {}) {
  const db = h.ctx.db
  const seq = (db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
  const id = newId()
  db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, asked_by, visibility, visible_to, body, mentions, created_at)
    VALUES (?, ?, ?, 'ai', NULL, ?, ?, ?, 'here is the form', '[]', ?)`).run(id, roomId, seq, mia.id, o.privateTo ? 'private' : 'room', o.privateTo ?? null, new Date().toISOString())
  db.query('UPDATE room_files SET message_id = ? WHERE id = ?').run(id, fileId)
  return { id, seq }
}

test('a member gets the pages, with no browser cache; a page is reused by its id, a guessed id is refused', async () => {
  const engine = fake()
  useEngine(engine)
  const { file } = await sentHwp()
  for (const who of [nora, mia]) {
    const r = await preview(who.client, dm.id, file.id)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toContain('no-store')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    const body = await r.json()
    expect(body).toMatchObject({ page: 1, pageCount: 2, sourceHash: sha256(fixture('agreement.hwp')) })
    expect(Buffer.from(body.png, 'base64').toString()).toBe('png page 1')
  }
  // one render for both (the same file, its id and sha256); a second page is its own
  expect(engine.calls).toBe(1)
  const first = await (await preview(nora.client, dm.id, file.id)).json()
  const again = await preview(nora.client, dm.id, file.id, `page=1&cacheId=${first.id}`)
  expect((await again.json()).id).toBe(first.id)
  expect((await preview(nora.client, dm.id, file.id, 'page=2')).status).toBe(200)
  expect(engine.calls).toBe(2)
  const guessed = await preview(nora.client, dm.id, file.id, `page=1&cacheId=${crypto.randomUUID()}`)
  expect(guessed.status).toBe(503)
  expect((await guessed.json()).error.params.reason).toBe('changed')
  // pages out of range are refused by the contract
  for (const q of ['page=0', 'page=201', 'page=x', '']) expect((await preview(nora.client, dm.id, file.id, q)).status).toBe(400)
})

test('not a member (an admin too), another room\'s address and no session are refused; an upload not sent is its sender\'s only', async () => {
  const engine = fake()
  useEngine(engine)
  const { file } = await sentHwp()
  const first = await (await preview(nora.client, dm.id, file.id)).json()
  for (const c of [otto.client, ada.client, owner]) {
    expect((await preview(c, dm.id, file.id)).status).toBe(404)
    // a cached page's id opens nothing either
    expect((await preview(c, dm.id, file.id, `page=1&cacheId=${first.id}`)).status).toBe(404)
  }
  // the file asked for under a room the person is in, but not the file's
  expect((await preview(mia.client, team.id, file.id)).status).toBe(404)
  expect((await preview(nora.client, team.id, file.id)).status).toBe(404)
  expect((await preview(null, dm.id, file.id)).status).toBe(401)
  // an upload not sent yet: the uploader only, as the inline read
  const unsent = await upload(mia.client, dm.id, 'draft.hwpx', fixture('agreement.hwpx'))
  expect((await preview(mia.client, dm.id, unsent.id)).status).toBe(200)
  expect((await preview(nora.client, dm.id, unsent.id)).status).toBe(404)
  // a file id that is not there
  expect((await preview(nora.client, dm.id, newId())).status).toBe(404)
  expect(engine.calls).toBe(2)
})

test("a hidden old answer's file, another person's private preview's file and a deleted message's file are refused", async () => {
  const engine = fake()
  useEngine(engine)
  // an AI preview only mia sees
  const priv = await upload(mia.client, dm.id, 'private.hwp', fixture('agreement.hwp'))
  putWithFile(dm.id, priv.id, { privateTo: mia.id })
  expect((await preview(nora.client, dm.id, priv.id)).status).toBe(404)
  expect((await preview(mia.client, dm.id, priv.id)).status).toBe(200)
  // an old answer hidden from nora (rooms/history.ts)
  const old = await upload(mia.client, dm.id, 'hidden.hwp', fixture('two-pages.hwp'))
  const answer = putWithFile(dm.id, old.id)
  expect((await preview(nora.client, dm.id, old.id)).status).toBe(200)
  h.ctx.db.query('INSERT INTO room_hidden_answers (room_id, user_id, message_id, see_seq) VALUES (?, ?, ?, ?)').run(dm.id, nora.id, answer.id, answer.seq)
  try {
    const r = await preview(nora.client, dm.id, old.id, 'page=2')
    expect(r.status).toBe(404)
    expect((await preview(mia.client, dm.id, old.id, 'page=2')).status).toBe(200)
  } finally {
    h.ctx.db.query('DELETE FROM room_hidden_answers WHERE message_id = ?').run(answer.id)
  }
  // deleted: gone for both
  const { file, message } = await sentHwp('deleted.hwp', fixture('synthetic-form.hwp'))
  expect((await preview(nora.client, dm.id, file.id)).status).toBe(200)
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${message.id}`)
  for (const c of [nora.client, mia.client]) expect((await preview(c, dm.id, file.id)).status).toBe(404)
})

test('someone who joined after the message, someone who left after a page was cached and an archived room are refused', async () => {
  const engine = fake()
  useEngine(engine)
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, ada.id] })
  const { file } = await sentHwp('group-form.hwp', Buffer.concat([fixture('agreement.hwp'), Buffer.from('group')]), group.id)
  const first = await (await preview(nora.client, group.id, file.id)).json()
  expect(first.id).toBeTruthy()
  // otto joins after it was sent: he does not see the message, so not its file (inline or as pages, cache id or not)
  await mia.client.call('POST', `/api/rooms/${group.id}/members`, { userIds: [otto.id] })
  expect((await h.fetch(`/api/rooms/${group.id}/files/${file.id}`, { headers: { cookie: otto.client.cookie! } })).status).toBe(404)
  expect((await preview(otto.client, group.id, file.id)).status).toBe(404)
  expect((await preview(otto.client, group.id, file.id, `page=1&cacheId=${first.id}`)).status).toBe(404)
  // nora leaves: the page cached for her is not hers any more
  await nora.client.call('POST', `/api/rooms/${group.id}/leave`)
  expect((await preview(nora.client, group.id, file.id, `page=1&cacheId=${first.id}`)).status).toBe(404)
  expect((await preview(ada.client, group.id, file.id, `page=1&cacheId=${first.id}`)).status).toBe(200)
  // a room that is gone (archived): nobody
  h.ctx.db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), group.id)
  try { expect((await preview(ada.client, group.id, file.id, `page=1&cacheId=${first.id}`)).status).toBe(404) }
  finally { h.ctx.db.query('UPDATE rooms SET archived_at = NULL WHERE id = ?').run(group.id) }
  expect(engine.calls).toBe(1)
})

test('a file on the download-only list is refused before the renderer, also after a page of it was cached', async () => {
  const engine = fake()
  useEngine(engine)
  const held = Buffer.concat([fixture('agreement.hwp'), Buffer.from('held')])
  h.ctx.files.quarantine.add(held, 'pptx')
  const { file } = await sentHwp('held.hwp', held)
  for (const c of [nora.client, mia.client]) {
    const r = await preview(c, dm.id, file.id)
    expect(r.status).toBe(503)
    expect((await r.json()).error.params.reason).toBe('quarantined')
  }
  expect(engine.calls).toBe(0)
  // a page made before the bytes went on the list is not served after
  const later = Buffer.concat([fixture('agreement.hwp'), Buffer.from('later')])
  const { file: f2 } = await sentHwp('later.hwp', later)
  const first = await (await preview(nora.client, dm.id, f2.id)).json()
  h.ctx.files.quarantine.add(later, 'pptx')
  const r = await preview(nora.client, dm.id, f2.id, `page=1&cacheId=${first.id}`)
  expect(r.status).toBe(503)
  expect((await r.json()).error.params.reason).toBe('quarantined')
  // the download stays
  expect((await h.fetch(`/api/rooms/${dm.id}/files/${f2.id}?download=1`, { headers: { cookie: nora.client.cookie! } })).status).toBe(200)
})

test('access is checked again after the render: a message deleted meanwhile gives no page; changed bytes are refused', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const engine = fake(() => gate)
  useEngine(engine)
  const { file, message } = await sentHwp('racing.hwp', Buffer.concat([fixture('agreement.hwp'), Buffer.from('race')]))
  const pending = preview(nora.client, dm.id, file.id)
  while (engine.calls === 0) await Bun.sleep(5)
  await mia.client.call('DELETE', `/api/rooms/${dm.id}/messages/${message.id}`)
  finish()
  expect((await pending).status).toBe(404)
  // the stored bytes are not the ones sent (a damaged disk, a hand edit): no page
  useEngine(fake())
  const { file: f2 } = await sentHwp('changed.hwp', Buffer.concat([fixture('agreement.hwp'), Buffer.from('changed')]))
  fs.appendFileSync(path.join(h.ctx.config.teamRoot, '.system', 'rooms', dm.id, f2.id), 'x')
  const r = await preview(nora.client, dm.id, f2.id)
  expect(r.status).toBe(503)
  expect((await r.json()).error.params.reason).toBe('changed')
})

test('a hard link or a symbolic link in place of the stored file is refused', async () => {
  useEngine(fake())
  const { file } = await sentHwp('linked.hwp', Buffer.concat([fixture('agreement.hwp'), Buffer.from('linked')]))
  const stored = path.join(h.ctx.config.teamRoot, '.system', 'rooms', dm.id, file.id)
  fs.linkSync(stored, stored + '.hl')
  try { expect((await preview(nora.client, dm.id, file.id)).status).toBe(404) } finally { fs.rmSync(stored + '.hl') }
  const copy = stored + '.copy'
  fs.copyFileSync(stored, copy); fs.rmSync(stored); fs.symlinkSync(copy, stored)
  try { expect((await preview(nora.client, dm.id, file.id)).status).toBe(404) } finally { fs.rmSync(stored); fs.renameSync(copy, stored) }
  expect((await preview(nora.client, dm.id, file.id)).status).toBe(200)
})

test('one render per person across team and room previews; over 20 MB is "limit" before any read', async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const engine = fake(() => gate)
  useEngine(engine)
  const home = path.join(h.ctx.config.teamRoot, 'users', mia.id)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'busy.hwp'), Buffer.concat([fixture('agreement.hwp'), Buffer.from('team busy')]))
  const team = h.fetch(`/api/files/hwp-preview?path=${encodeURIComponent(`users/${mia.id}/busy.hwp`)}&page=1`, { headers: { cookie: mia.client.cookie! } })
  while (engine.calls === 0) await Bun.sleep(5)
  const { file } = await sentHwp('busy-room.hwp', Buffer.concat([fixture('agreement.hwp'), Buffer.from('room busy')]))
  const busy = await preview(mia.client, dm.id, file.id)
  expect(busy.status).toBe(503)
  expect((await busy.json()).error.params.reason).toBe('busy')
  finish()
  expect((await team).status).toBe(200)
  // a file larger than the preview reads (HWP_LIMITS.inputBytes)
  useEngine(fake())
  const { file: big } = await sentHwp('big.hwp', Buffer.alloc(20 * 1024 * 1024 + 1, 1))
  const r = await preview(nora.client, dm.id, big.id)
  expect(r.status).toBe(503)
  expect((await r.json()).error.params.reason).toBe('limit')
})

test('a file that is not Hangul is "unsupported" and never reaches the renderer', async () => {
  const engine = fake()
  useEngine(engine)
  const f = await upload(mia.client, dm.id, 'plan.txt', new TextEncoder().encode('quarterly numbers'))
  await send(mia.client, dm.id, [f.id])
  const r = await preview(nora.client, dm.id, f.id)
  expect(r.status).toBe(503)
  expect((await r.json()).error.params.reason).toBe('unsupported')
  expect(engine.calls).toBe(0)
})

test('the plugin off: "disabled" for a room file and a team file alike; Me.server.hwpPreview follows the plugin', async () => {
  componentC(h.ctx).hwp = plugged
  const { file } = await sentHwp('off.hwp')
  const r = await preview(nora.client, dm.id, file.id)
  expect(r.status).toBe(503)
  const body = await r.json()
  expect(body.error.code).toBe('unavailable')
  expect(body.error.params.reason).toBe('disabled')
  // the room's checks come first: an outsider is not told the plugin's state, a held file is still download-only
  for (const c of [otto.client, owner]) expect((await preview(c, dm.id, file.id)).status).toBe(404)
  const held = Buffer.concat([fixture('agreement.hwp'), Buffer.from('held while off')])
  h.ctx.files.quarantine.add(held, 'pptx')
  const { file: heldFile } = await sentHwp('held-off.hwp', held)
  const q = await preview(nora.client, dm.id, heldFile.id)
  expect(q.status).toBe(503)
  expect((await q.json()).error.params.reason).toBe('quarantined')
  // the team file preview's own answer, word for word
  const home = path.join(h.ctx.config.teamRoot, 'users', mia.id)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'team.hwp'), fixture('agreement.hwp'))
  const t = await h.fetch(`/api/files/hwp-preview?path=${encodeURIComponent(`users/${mia.id}/team.hwp`)}&page=1`, { headers: { cookie: mia.client.cookie! } })
  expect(t.status).toBe(503)
  const { requestId: _a, ...room } = body.error
  const { requestId: _b, ...teamFile } = (await t.json()).error
  expect(teamFile).toEqual(room)
  // the web learns it from Me: off here, on while the plugin's package is usable
  expect((await nora.client.call('GET', '/api/me')).server.hwpPreview).toBeUndefined()
  const plugins = pluginsOf(h.ctx), was = plugins.hwpPreviewOn
  plugins.hwpPreviewOn = () => true
  try { expect((await nora.client.call('GET', '/api/me')).server.hwpPreview).toBe(true) } finally { plugins.hwpPreviewOn = was }
})

test("a team file's preview still works, with the same renderer and checks", async () => {
  const engine = fake()
  useEngine(engine)
  const home = path.join(h.ctx.config.teamRoot, 'users', mia.id)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'team.hwp'), fixture('two-pages.hwp'))
  const url = `/api/files/hwp-preview?path=${encodeURIComponent(`users/${mia.id}/team.hwp`)}&page=2`
  const r = await h.fetch(url, { headers: { cookie: mia.client.cookie! } })
  expect(r.status).toBe(200)
  expect(await r.json()).toMatchObject({ page: 2, sourceHash: sha256(fixture('two-pages.hwp')) })
  expect((await h.fetch(url, { headers: { cookie: nora.client.cookie! } })).status).toBe(404)
  // the same bytes in a room are their own cache entry, checked as the room's
  const { file } = await sentHwp('two-pages.hwp', fixture('two-pages.hwp'))
  expect((await preview(nora.client, dm.id, file.id, 'page=2')).status).toBe(200)
  expect(engine.calls).toBe(2)
})
