// Copy link in the Share dialogs (docs/decisions/20261116-chat-share-copy-link.md, QA TC-3933): the link is the chat's
// /c/<id> or the project's /projects/<id>, no new access path. Who can't see it gets the answer of a chat (a project)
// that is not there: the same 404 body, with no title and no name in it. Covered: a chat shared with one person, a
// private ("Only me") chat, a team project, for a member outside it and an admin.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'

setDefaultTimeout(60_000)
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-share-copy-link' }) })
afterAll(async () => { await h.close() })

const TITLE = 'Quarterly layoffs draft'
/** the error body without its request id, and its whole text */
async function answer(user: string, p: string) {
  const r = await h.req(user, p)
  const j = (await r.json()) as { error: Record<string, unknown> }
  delete j.error.requestId
  return { status: r.status, body: j, text: JSON.stringify(j) }
}
const names = () => (h.ctx.db.query('SELECT name FROM users WHERE id = ?').get('alice') as { name: string }).name

describe('a copied link opens nothing new', () => {
  test('a chat shared with bob: erin (member) and carol (admin) get the 404 of a missing chat, no title, no name', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    await h.api('alice').call(API.updateChat, { params: { id: c.id }, body: { title: TITLE } })
    let r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }] } })
    if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }], confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
    expect((await h.req('bob', `/api/chats/${c.id}`)).status).toBe(200)
    for (const u of ['erin', 'carol']) {
      const hidden = await answer(u, `/api/chats/${c.id}`)
      const missing = await answer(u, `/api/chats/${crypto.randomUUID()}`)
      expect(hidden.status).toBe(404)
      expect(hidden.body).toEqual(missing.body)
      expect(hidden.text).not.toContain(TITLE)
      expect(hidden.text).not.toContain(names())
      expect((await answer(u, `/api/chats/${c.id}/messages`)).status).toBe(404)
    }
  })

  test('a private chat: its own person only', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    await h.api('alice').call(API.updateChat, { params: { id: c.id }, body: { title: TITLE } })
    expect((await h.req('alice', `/api/chats/${c.id}`)).status).toBe(200)
    const hidden = await answer('bob', `/api/chats/${c.id}`)
    expect(hidden.status).toBe(404)
    expect(hidden.body).toEqual((await answer('bob', `/api/chats/${crypto.randomUUID()}`)).body)
    expect(hidden.text).not.toContain(TITLE)
  })

  test('a team project with bob: erin gets the 404 of a missing project, no name', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Layoff plan', scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
    expect((await h.req('bob', `/api/projects/${p.id}`)).status).toBe(200)
    const hidden = await answer('erin', `/api/projects/${p.id}`)
    expect(hidden.status).toBe(404)
    expect(hidden.body).toEqual((await answer('erin', `/api/projects/${crypto.randomUUID()}`)).body)
    expect(hidden.text).not.toContain('Layoff plan')
    expect(hidden.text).not.toContain(names())
  })
})
