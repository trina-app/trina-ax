// "참고한 파일" under an answer (GET /api/chats/:id/messages/:messageId/sources, docs/DECISIONS.md "Sources under each
// answer"): the list names only files the viewer may open now. A file they lost access to, a deleted or moved file,
// and every file of someone else's answer give nothing away: no name, path, folder or count of hidden files in another
// person's chat. The list is not in message history or realtime copies (only its count is). Step labels still name
// the paths the AI used, as before (docs/DECISIONS.md: re-checking them is a separate change).
// Same isolated instance + world as the permission matrix (tests/security/lib).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { startInstance, type Instance } from './lib/instance'
import { buildWorld, type World } from './lib/world'

setDefaultTimeout(180_000)
let W: World
let inst: Instance
beforeAll(async () => { inst = await startInstance('answer-sources'); W = await buildWorld(inst, { sharedSubscriptions: true }) })
afterAll(async () => { for (const s of Object.values(W?.sockets ?? {})) s.close(); await inst?.close() })

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const read = (file_path: string) => ({ tool: 'read', args: { file_path } })

describe('answer sources follow the viewer\'s access', () => {
  test('a file alice lost access to, a deleted one and a moved one: counted only, nothing about them in any answer', async () => {
    const alice = W.as.memberIn
    const secret = `${W.groups.mktFolder}/SEC-SRC-MKTNAME-4c1.md`
    fs.writeFileSync(path.join(inst.team, secret), '# marketing only SEC-SRC-BODY-77\n')
    fs.writeFileSync(path.join(inst.team, 'users/alice/SEC-SRC-GONE-91.md'), 'gone soon\n')
    fs.writeFileSync(path.join(inst.team, 'users/alice/SEC-SRC-MOVE-55.md'), 'moved soon\n')
    const chat = (await alice.ok('POST', '/api/chats', { title: 'sources sec' })).id as string
    const sent = await alice.ok('POST', `/api/chats/${chat}/messages`, { clientMessageId: cm(), attachmentIds: [],
      content: fake(read(secret), read('users/alice/SEC-SRC-GONE-91.md'), read('users/alice/SEC-SRC-MOVE-55.md'), read('shared/readme.md'), { say: 'done' }) })
    const done = await W.sockets.alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 30_000)
    expect(done.data.message.sourceCount).toBe(4)
    // the finished answer and the history carry the count only, never the list
    expect(Object.keys(done.data.message).filter((k) => /source/i.test(k))).toEqual(['sourceCount'])
    const url = `/api/chats/${chat}/messages/${sent.assistantMessage.id}/sources`
    expect((await alice.get(url)).text).toContain('SEC-SRC-MKTNAME-4c1')
    // other people: the same 404 as for any other message of alice's
    for (const who of ['other', 'memberOut', 'owner', 'admin'] as const) {
      const r = await W.as[who].get(url)
      expect({ who, status: r.status }).toEqual({ who, status: 404 })
      expect(r.text).not.toContain('SEC-SRC-')
      expect(r.text).not.toContain('readme')
    }
    fs.rmSync(path.join(inst.team, 'users/alice/SEC-SRC-GONE-91.md'))
    fs.renameSync(path.join(inst.team, 'users/alice/SEC-SRC-MOVE-55.md'), path.join(inst.team, 'users/alice/renamed.md'))
    await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['erin'] })
    try {
      const r = await alice.get(url)
      expect(r.status).toBe(200)
      expect(r.json).toEqual({ files: [{ path: 'shared/readme.md', name: 'readme.md', locs: [], via: ['read'] }], unavailable: 3 })
      for (const s of ['SEC-SRC-', W.groups.mktFolder, 'renamed']) expect(r.text).not.toContain(s)
      const history = await alice.get(`/api/chats/${chat}/messages`)
      const answer = history.json.items.find((m: { id: string }) => m.id === sent.assistantMessage.id)
      expect(answer.sourceCount).toBe(4)
      expect(Object.keys(answer).filter((k) => /source/i.test(k))).toEqual(['sourceCount'])
    } finally {
      await W.as.owner.ok('PATCH', `/api/admin/groups/${W.groups.marketing}`, { memberIds: ['alice', 'erin'] })
    }
  })

  test('a message id of another chat, or a user message, gives nothing', async () => {
    const alice = W.as.memberIn
    const other = (await alice.ok('POST', '/api/chats', { title: 'other' })).id as string
    // alice's answer in chat A, asked for through another chat of hers
    const wrong = await alice.get(`/api/chats/${other}/messages/${W.ids.assistantMsg}/sources`)
    expect(wrong.status).toBe(404)
    const user = await alice.get(`/api/chats/${W.ids.chatA}/messages/${W.ids.userMsg}/sources`)
    expect(user.json).toEqual({ files: [], unavailable: 0 })
    // bob, through his own chat id, still cannot reach alice's answer
    expect((await W.as.memberOut.get(`/api/chats/${W.ids.bobChat}/messages/${W.ids.assistantMsg}/sources`)).status).toBe(404)
  })
})
