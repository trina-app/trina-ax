// What a project's chat room tells each member for the web's buttons (docs/decisions/20261120-project-is-room.md D5):
// Room.projectRoom for every member (also one who cannot open the project's folder now), Room.project.attach (write on
// the project and its Chat attachments folder; read-only: 'read_only'; only Chat attachments closed: 'folder') and
// Room.project.leave ('yes', or 'last' for the last person); a plain private channel has none of them.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { CHAT_FILES_FOLDER } from '@mycel/shared'
import { afterAccessChange, captureState, ensureFolderRow } from '../../server/src/admin/folders'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })
/** a person's rule on a folder set straight in the table, then the access change hooks as a save runs them */
function setRule(folder: string, userId: string, access: 'read' | 'write' | 'none', limited = false) {
  const before = captureState(h.ctx.db)
  const f = ensureFolderRow(h.ctx.db, folder).id
  if (limited) h.ctx.db.query('UPDATE folders SET limited = 1 WHERE id = ?').run(f)
  h.ctx.db.query("DELETE FROM folder_rules WHERE folder_id = ? AND subject_type = 'user' AND subject_id = ?").run(f, userId)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', ?, ?)").run(crypto.randomUUID(), f, userId, access)
  afterAccessChange(h.ctx, before, { actor: null as unknown as string, target: folder })
}

test('projectRoom for every member; attach and leave by person; nothing of it on a plain channel', async () => {
  h = await harness('b-project-room-viewer')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id), user(otto.id)] })
  const room = await mia.client.call('POST', `/api/projects/${launch.id}/room`)
  const folder = room.project.folderPath as string
  expect(room.projectRoom).toBe(true)
  expect(room.project).toMatchObject({ attach: 'ok', leave: 'yes' })
  // read-only on the project: no files from the computer
  setRule(folder, nora.id, 'read')
  const asNora = await nora.client.call('GET', `/api/rooms/${room.id}`)
  expect(asNora.projectRoom).toBe(true)
  expect(asNora.project).toMatchObject({ canSave: false, attach: 'read_only', leave: 'yes' })
  // only its Chat attachments folder closed to otto
  fs.mkdirSync(path.join(h.ctx.files.fx.root, folder, CHAT_FILES_FOLDER.en), { recursive: true })
  // (a limited folder: what comes from the project's folder stops there; the others keep writing by their own rules)
  setRule(`${folder}/${CHAT_FILES_FOLDER.en}`, mia.id, 'write', true)
  setRule(`${folder}/${CHAT_FILES_FOLDER.en}`, otto.id, 'read', true)
  expect((await otto.client.call('GET', `/api/rooms/${room.id}`)).project).toMatchObject({ canSave: true, attach: 'folder' })
  // a plain private channel: none of it
  const plain = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Plain' })
  expect(plain.projectRoom).toBeUndefined()
  expect(plain.project).toBeUndefined()
})

test('the last person in it: leave is "last"', async () => {
  h = await harness('b-project-room-viewer-last')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const solo = await mia.client.call('POST', '/api/projects', { name: 'Solo', participants: [] })
  const room = await mia.client.call('POST', `/api/projects/${solo.id}/room`)
  expect(room.project.leave).toBe('last')
})
