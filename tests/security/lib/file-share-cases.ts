import type { Spec } from './cases'
import { C, type Who, type World } from './world'

// Files shared one by one (docs/DECISIONS.md "A member shares their own files", server/src/files/shares.ts). Every case
// aims at alice's own file users/alice/todo.md: only alice makes its link, sees or changes who has it, and reads its
// bytes by the link; everyone else, the owner and admins included, gets "no access" with nothing about the file (no
// name, no content). A request or an answer on an id that does not exist is 404 for everyone.
const made = new WeakMap<World, Promise<string>>()
/** alice's link to users/alice/todo.md, made once per world (no one added: nobody else may open it) */
function aliceLink(w: World): Promise<string> {
  let p = made.get(w)
  if (!p) made.set(w, (p = w.as.memberIn.ok('POST', '/api/files/link', { path: 'users/alice/todo.md' }).then((r) => r.id as string)))
  return p
}
const nothingOfAlice = (text: string, who: Who, what: string) => {
  if (who === 'memberIn') return
  for (const c of [C.aliceFile, C.aliceFileOld, 'todo.md']) if (text.includes(c)) throw new Error(`${who}: ${what} showed alice's file`)
}

export const FILE_SHARE_SPECS: Record<string, Spec> = {
  fileLink: { build: (c) => c.post('/api/files/link', { path: 'users/alice/todo.md' }), scope: 'users-alice' },
  fileShares: { build: (c) => c.get('/api/files/shares?path=users%2Falice%2Ftodo.md'), scope: 'users-alice' },
  // (an empty change: alice passes and nothing changes)
  putFileShares: { build: (c) => c.put('/api/files/shares', { path: 'users/alice/todo.md', add: [], remove: [] }), scope: 'users-alice' },
  // the link page answers everyone signed in, but says nothing about the file to anyone but alice
  sharedFile: {
    build: async (c, w) => c.get(`/api/files/shared/${await aliceLink(w)}`), scope: 'self',
    check: (r, _w, who) => {
      nothingOfAlice(r.text, who, 'the link page')
      if (who !== 'memberIn' && r.status === 200 && r.json?.status !== 'no_access') throw new Error(`${who}: the link page answered ${r.json?.status}`)
    },
  },
  sharedFileDownload: { build: async (c, w) => c.get(`/api/files/shared/${await aliceLink(w)}/download`), scope: 'users-alice',
    check: (r, _w, who) => nothingOfAlice(r.text, who, 'the link\'s bytes') },
  requestFileAccess: { build: (c) => c.post('/api/files/shared/AAAAAAAAAAAAAAAAAAAAAA/request', {}), scope: 'nobody' },
  answerFileRequest: { build: (c) => c.post(`/api/files/requests/${crypto.randomUUID()}`, { answer: 'approve' }), scope: 'nobody' },
  fileSharesCount: { build: (c) => c.get('/api/admin/file-shares'), scope: 'byLevel' },
  // the team owner's Remove all: an admin is refused (owner_only)
  removeAllFileShares: { build: (c) => c.del('/api/admin/file-shares'), scope: 'own-owner' },
}
