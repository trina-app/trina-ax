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
/** a new chat of `c`'s person with no project */
const ownChat = async (c: Client) => (await c.ok('POST', '/api/chats', {})).id as string

export const NAV_FOLDER_SPECS: Record<string, Spec> = {
  // my own folders only: the list never names alice's to anyone else
  listNavFolders: {
    build: async (c, w) => { await aliceFolder(w, 'chats'); return c.get('/api/nav-folders') }, scope: 'self',
    check: (r, _w, who) => noCanary(r.text, who, 'the folder list'),
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
      if (who !== 'memberIn' && r.status !== 401 && r.status !== 404 && r.status !== 403) throw new Error(`${who}: renaming alice's folder answered ${r.status}, not 404`)
    },
  },
  // deleting: alice's own only (a new folder of hers each time, so each persona aims at one that is there)
  deleteNavFolder: {
    build: async (c, w) => c.del(`/api/nav-folders/${await aliceFolder(w, 'chats', true)}`), scope: 'own-alice',
    check: (r, _w, who) => { if (who !== 'memberIn' && r.status === 403) throw new Error(`${who}: deleting alice's folder answered 403, not 404`) },
  },
  // ordering names my own ids; alice's id in someone else's request is ignored (and never echoed back)
  orderNavFolders: {
    build: async (c, w) => c.put('/api/nav-folders/order', { kind: 'chats', ids: [await aliceFolder(w, 'chats')] }), scope: 'self',
    check: (r, _w, who) => noCanary(r.text, who, 'ordering'),
  },
  // taking a chat out of my folder: the chat's person only (alice's chat in her project). Then: her own chat with no
  // project goes into her folder, her project chat is refused (409), and anyone else's own chat cannot go into hers (404)
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
        if (project.status !== 409) throw new Error(`a project chat went into a folder: ${project.status}`)
        return
      }
      if (r.status === 403) throw new Error(`${who}: alice's chat answered 403, not 404`)
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
