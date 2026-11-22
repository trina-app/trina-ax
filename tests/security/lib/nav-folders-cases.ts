import type { Spec } from './cases'
import type { Client } from './instance'
import type { Who, World } from './world'

// List folders (docs/DECISIONS.md "List folders", server/src/chat/nav-folders.ts): a person's own folders for their AI
// chats and conversations. Only the maker sees, names, orders or fills them: the owner and admins are refused like
// everyone else (404, never 403), and no response to anyone else carries a folder's name. Every case aims at alice's
// (memberIn) folders, made on first use; a folder's name is a canary that only alice may see.
export const NAV_FOLDER_CANARY = 'SEC-NAVFOLDER-ALICE-7731'

const made = new WeakMap<World, Map<string, Promise<string>>>()
/** alice's folder of that kind, made once per world (`fresh`: a new one each call, for the case that deletes it) */
function aliceFolder(w: World, kind: 'chats' | 'rooms', fresh = false): Promise<string> {
  const make = async () => (await w.as.memberIn.ok('POST', '/api/nav-folders', { kind, name: `${NAV_FOLDER_CANARY} ${kind}${fresh ? ' ' + crypto.randomUUID().slice(0, 8) : ''}` })).id as string
  if (fresh) return make()
  let m = made.get(w)
  if (!m) made.set(w, (m = new Map()))
  if (!m.has(kind)) m.set(kind, make())
  return m.get(kind)!
}
const noCanary = (text: string, who: Who, what: string) => {
  if (who !== 'memberIn' && text.includes(NAV_FOLDER_CANARY)) throw new Error(`${who}: ${what} showed alice's folder name`)
}
// someone who must change the password first is stopped before any lookup (403 password_change_required): a refusal that
// names nothing, as good as the 404 the others get
const pwGate = (who: Who, r: { status: number; json: any }) => who === 'pwchange' && r.status === 403 && r.json?.error?.code === 'password_change_required'
/** a new chat of `c`'s person with no project */
const ownChat = async (c: Client) => (await c.ok('POST', '/api/chats', {})).id as string

const fake = (d: unknown) => '@fake ' + JSON.stringify(d)
/** erin (a member of Team plan) files its shared chat: refused while she never wrote in it (it is not in her history,
 * 409 folder_not_in_history), filed once she did; alice's copy never carries erin's folder, nor erin's alice's */
async function otherFilesSharedChat(w: World) {
  const erin = w.as.other, alice = w.as.memberIn
  const mineF = (await erin.ok('POST', '/api/nav-folders', { kind: 'chats', name: `erin ${crypto.randomUUID().slice(0, 8)}` })).id as string
  const chat = (await alice.ok('POST', '/api/chats', { title: 'team chat to file', projectId: w.ids.projTeam })).id as string
  const before = await erin.req('PUT', `/api/chats/${chat}/folder`, { folderId: mineF })
  if (before.status !== 409 || before.json?.error?.params?.reason !== 'folder_not_in_history') throw new Error(`erin filed a shared chat she never wrote in: ${before.status}`)
  const sent = await erin.ok('POST', `/api/chats/${chat}/messages`, { clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], content: fake({ say: 'ok' }) })
  await w.sockets.erin.next('message.done', (f: any) => f.data.messageId === sent.assistantMessage.id, 30_000)
  const put = await erin.req('PUT', `/api/chats/${chat}/folder`, { folderId: mineF })
  if (put.status !== 200 || put.json?.folderId !== mineF) throw new Error(`erin could not file a shared chat she wrote in: ${put.status} ${put.text.slice(0, 200)}`)
  const aliceF = await aliceFolder(w, 'chats')
  await alice.ok('PUT', `/api/chats/${chat}/folder`, { folderId: aliceF })
  const a = await alice.ok('GET', `/api/chats/${chat}`), e = await erin.ok('GET', `/api/chats/${chat}`)
  if (a.folderId !== aliceF || e.folderId !== mineF) throw new Error(`a shared chat carried another person's folder: alice ${a.folderId}, erin ${e.folderId}`)
  for (const p of ['/api/chats', '/api/chats/groups', '/api/nav-folders']) {
    const t = (await erin.req('GET', p)).text
    if (t.includes(aliceF) || t.includes(NAV_FOLDER_CANARY)) throw new Error(`erin's ${p} showed alice's folder`)
  }
}
/** alice shares a chat with carol (an admin) by name and files it: carol's copy, list and groups never carry the folder */
async function adminSeesNoFolder(w: World) {
  const alice = w.as.memberIn, carol = w.as.admin
  const chat = (await alice.ok('POST', '/api/chats', { title: 'shared with carol' })).id as string
  const subjects = [{ subjectType: 'user', subjectId: 'carol' }]
  const pv = await alice.ok('POST', `/api/chats/${chat}/audience/preview`, { subjects })
  await alice.ok('PUT', `/api/chats/${chat}/audience`, { subjects, confirmKey: pv.previewKey })
  const f = await aliceFolder(w, 'chats')
  await alice.ok('PUT', `/api/chats/${chat}/folder`, { folderId: f })
  const got = await carol.ok('GET', `/api/chats/${chat}`)
  if (got.folderId !== undefined) throw new Error(`the admin saw alice's folder on a chat shared with them: ${got.folderId}`)
  for (const p of ['/api/chats', '/api/chats/groups', `/api/chats/${chat}`]) {
    const t = (await carol.req('GET', p)).text
    if (t.includes(f) || t.includes(NAV_FOLDER_CANARY)) throw new Error(`the admin's ${p} showed alice's folder`)
  }
}

export const NAV_FOLDER_SPECS: Record<string, Spec> = {
  // my own folders only: the list never names alice's to anyone else
  listNavFolders: {
    build: async (c, w) => { await aliceFolder(w, 'chats'); return c.get('/api/nav-folders') }, scope: 'self',
    check: async (r, w, who) => {
      noCanary(r.text, who, 'the folder list')
      // and her folder's own chat page (GET /api/chats?folderId=) is hers alone
      if (r.status !== 200) return
      const page = await w.as[who].req('GET', `/api/chats?folderId=${await aliceFolder(w, 'chats')}`)
      if (who === 'memberIn' ? page.status !== 200 : page.status !== 404) throw new Error(`${who}: alice's folder page answered ${page.status}`)
    },
  },
  // anyone makes their own; a body that names a person is refused (strict), and the folder is deleted again
  createNavFolder: {
    build: (c) => c.post('/api/nav-folders', { kind: 'chats', name: `own ${crypto.randomUUID().slice(0, 8)}` }), scope: 'self',
    check: async (r, w, who) => {
      if (r.status !== 201) return
      await w.as[who].ok('DELETE', `/api/nav-folders/${r.json.id}`)
      const spoof = await w.as[who].req('POST', '/api/nav-folders', { kind: 'chats', name: 'x', userId: 'alice' })
      if (spoof.status !== 400) throw new Error(`a body naming a person was not refused: ${spoof.status}`)
    },
  },
  // renaming: alice's own only (the same name again: nothing changes)
  updateNavFolder: {
    build: async (c, w) => c.patch(`/api/nav-folders/${await aliceFolder(w, 'chats')}`, { name: `${NAV_FOLDER_CANARY} chats` }), scope: 'own-alice',
    check: (r, _w, who) => {
      noCanary(r.text, who, 'a rename')
      if (who !== 'memberIn' && r.status !== 401 && r.status !== 404 && !pwGate(who, r)) throw new Error(`${who}: renaming alice's folder answered ${r.status}, not 404`)
    },
  },
  // deleting: alice's own only (a new folder of hers each time, so each persona aims at one that is there)
  deleteNavFolder: {
    build: async (c, w) => c.del(`/api/nav-folders/${await aliceFolder(w, 'chats', true)}`), scope: 'own-alice',
    check: (r, _w, who) => { if (who !== 'memberIn' && r.status === 403 && !pwGate(who, r)) throw new Error(`${who}: deleting alice's folder answered 403, not 404`) },
  },
  // ordering names my own ids; alice's id in someone else's request is ignored (and never echoed back)
  orderNavFolders: {
    build: async (c, w) => c.put('/api/nav-folders/order', { kind: 'chats', ids: [await aliceFolder(w, 'chats')] }), scope: 'self',
    check: async (r, w, who) => {
      noCanary(r.text, who, 'ordering')
      if (who === 'memberIn' || r.status !== 200) return
      // alice's folders keep her order: her first folder is still at its place
      const id = await aliceFolder(w, 'chats')
      const before = (await w.as.memberIn.ok('GET', '/api/nav-folders')).items.find((f: any) => f.id === id)?.position
      await w.as[who].req('PUT', '/api/nav-folders/order', { kind: 'chats', ids: [id] })
      const after = (await w.as.memberIn.ok('GET', '/api/nav-folders')).items.find((f: any) => f.id === id)?.position
      if (before !== after) throw new Error(`${who}: reordering moved alice's folder`)
    },
  },
  // taking a chat out of my folder: the chat's person only (alice's chat in her project). Then: her own chat with no
  // project goes into her folder, and so does her project chat (any chat of her history, owner 2026-11-22; taken out
  // again after), and anyone else's own chat cannot go into hers (404). erin files a shared project chat once she wrote
  // in it (otherFilesSharedChat); an admin's copy of a chat in alice's folder carries none (adminSeesNoFolder)
  setChatFolder: {
    build: (c, w) => c.put(`/api/chats/${w.ids.chatA}/folder`, { folderId: null }), scope: 'own-alice-chat',
    check: async (r, w, who) => {
      if (r.status === 401) return
      const folder = await aliceFolder(w, 'chats')
      const me = w.as[who]
      if (who === 'memberIn') {
        const chat = await ownChat(me)
        const put = await me.req('PUT', `/api/chats/${chat}/folder`, { folderId: folder })
        if (put.status !== 200 || put.json?.folderId !== folder) throw new Error(`alice could not file her own chat: ${put.status} ${put.text.slice(0, 200)}`)
        await me.ok('DELETE', `/api/chats/${chat}`)
        const project = await me.req('PUT', `/api/chats/${w.ids.chatA}/folder`, { folderId: folder })
        if (project.status !== 200 || project.json?.folderId !== folder) throw new Error(`alice could not file her project chat: ${project.status} ${project.text.slice(0, 200)}`)
        await me.ok('PUT', `/api/chats/${w.ids.chatA}/folder`, { folderId: null })
        return
      }
      if (r.status === 403 && !pwGate(who, r)) throw new Error(`${who}: alice's chat answered 403, not 404`)
      if (who === 'other') await otherFilesSharedChat(w)
      if (who === 'admin') await adminSeesNoFolder(w)
      const chat = await ownChat(me).catch(() => null)
      if (!chat) return
      const put = await me.req('PUT', `/api/chats/${chat}/folder`, { folderId: folder })
      await me.req('DELETE', `/api/chats/${chat}`)
      if (put.status !== 404) throw new Error(`${who}: their chat went into alice's folder: ${put.status}`)
    },
  },
  // taking a room out of my folder: the DM's two people, each for themselves. Then: alice files the DM in her folder and
  // erin's copy of it carries no folder; erin cannot file it in alice's folder (404)
  setRoomFolder: {
    build: (c, w) => c.put(`/api/rooms/${w.ids.dmRoom}/folder`, { folderId: null }), scope: 'room-dm',
    check: async (r, w, who) => {
      if (r.status !== 200) return
      const folder = await aliceFolder(w, 'rooms')
      if (who === 'memberIn') {
        const put = await w.as.memberIn.req('PUT', `/api/rooms/${w.ids.dmRoom}/folder`, { folderId: folder })
        if (put.status !== 200 || put.json?.folderId !== folder) throw new Error(`alice could not file the DM: ${put.status} ${put.text.slice(0, 200)}`)
        const peer = await w.as.other.req('GET', `/api/rooms/${w.ids.dmRoom}`)
        if (peer.status !== 200 || peer.json?.folderId !== undefined) throw new Error(`erin's copy of the DM carries alice's folder: ${peer.text.slice(0, 200)}`)
        await w.as.memberIn.ok('PUT', `/api/rooms/${w.ids.dmRoom}/folder`, { folderId: null })
        return
      }
      const put = await w.as[who].req('PUT', `/api/rooms/${w.ids.dmRoom}/folder`, { folderId: folder })
      if (put.status !== 404) throw new Error(`${who}: the DM went into alice's folder: ${put.status}`)
    },
  },
}
