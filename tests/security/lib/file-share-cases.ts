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
/** a guest of the team (made once per world): never a recipient */
const guests = new WeakMap<World, Promise<string>>()
function guestOf(w: World): Promise<string> {
  let p = guests.get(w)
  if (!p) guests.set(w, (p = w.as.owner.ok('POST', '/api/admin/users', { username: 'gwen', name: 'Gwen Guest', role: 'member', locale: 'en' }).then((r) => {
    const id = (r.user?.id ?? r.id) as string
    w.inst.ctx.db.query('UPDATE users SET guest = 1 WHERE id = ?').run(id)
    return id
  })))
  return p
}
/** a press of two of bob's files shared with alice by name (made once per world): its list answers only alice, the one
 * person it told, never bob who pressed it, the owner or an admin */
const presses = new WeakMap<World, Promise<string>>()
function bobPressForAlice(w: World): Promise<string> {
  let p = presses.get(w)
  if (!p) presses.set(w, (p = (async () => {
    const paths = ['users/bob/press-1.md', 'users/bob/press-2.md']
    for (const path of paths) await w.as.memberOut.ok('PUT', '/api/files/content', { path, content: 'press', baseSha256: null })
    await w.as.memberOut.ok('POST', '/api/files/shares/batch', { paths, add: [{ subjectType: 'user', subjectId: 'alice' }] })
    const row = w.inst.ctx.db.query("SELECT source_id FROM file_share_notices WHERE user_id = 'alice' AND source_id LIKE 'b:%' ORDER BY created_at DESC LIMIT 1").get() as { source_id: string }
    return row.source_id.slice(2)
  })()))
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
  // Files › Shared with me (file sharing P2): every signed-in member reads their own list; alice's file (shared with
  // nobody) is in no one's, the owner's and admins' included
  sharedWithMe: {
    build: async (c, w) => { await aliceLink(w); return c.get('/api/files/shared-with-me') }, scope: 'self',
    check: (r, _w, who) => {
      nothingOfAlice(r.text, who, 'Shared with me')
      if (r.status === 200 && JSON.stringify(r.json).includes('users/')) throw new Error(`${who}: Shared with me showed a path`)
    },
  },
  sharedFileDownload: { build: async (c, w) => c.get(`/api/files/shared/${await aliceLink(w)}/download`), scope: 'users-alice',
    check: (r, _w, who) => nothingOfAlice(r.text, who, 'the link\'s bytes') },
  // a press of several files (QA TC-3510): anyone signed in may call it, but only for files they may share. Aimed at
  // alice's own file with a guest as the recipient: alice is refused for the guest (400) before anything is written;
  // everyone else, the owner and admins included, gets every file refused (not theirs) and nothing about the people
  shareFilesBatch: {
    build: async (c, w) => c.post('/api/files/shares/batch', { paths: ['users/alice/todo.md'], add: [{ subjectType: 'user', subjectId: await guestOf(w) }] }), scope: 'self',
    check: async (r, w, who) => {
      // the answer lists each refused path as the caller sent it (failed[].path is the caller's own input, not a finding):
      // look for alice's file in everything else, and require the words for her file to be the words for a file that does
      // not exist at all (no existence, name or size oracle)
      nothingOfAlice(JSON.stringify(r.json?.failed ? { ...r.json, failed: r.json.failed.map(({ path: _echo, ...rest }: Record<string, unknown>) => rest) } : r.json ?? r.text), who, 'a press')
      if (who !== 'memberIn' && r.status === 200) {
        const none = await w.as[who].post('/api/files/shares/batch', { paths: ['users/alice/never-made.md'], add: [{ subjectType: 'user', subjectId: await guestOf(w) }] })
        const a = r.json?.failed?.[0], b = none.json?.failed?.[0]
        const bare = ({ path: _echo, ...rest }: Record<string, unknown> = {}) => JSON.stringify(rest)
        if (!a || !b || bare(a) !== bare(b)) throw new Error(`${who}: a press of alice's file answered differently from a file that does not exist: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
      }
      if (who === 'memberIn' && r.status !== 400) throw new Error(`alice: a press naming a guest answered ${r.status}`)
      if (who !== 'memberIn' && r.status === 200 && (r.json?.shared?.length || r.json?.failed?.length !== 1)) throw new Error(`${who}: a press of alice's file shared ${JSON.stringify(r.json?.shared)}`)
      const g = w.inst.ctx.db.query("SELECT COUNT(*) n FROM file_share_grants g JOIN file_shares s ON s.id = g.share_id WHERE s.path = 'users/alice/todo.md'").get() as { n: number }
      if (g.n) throw new Error(`${who}: a press left a grant on alice's file`)
    },
  },
  // a press's list: only the person it told (alice), never bob who pressed it, the owner or an admin
  sharedBatch: { build: async (c, w) => c.get(`/api/files/shared-batch/${await bobPressForAlice(w)}`), scope: 'own-alice' },
  requestFileAccess: { build: (c) => c.post('/api/files/shared/AAAAAAAAAAAAAAAAAAAAAA/request', {}), scope: 'nobody' },
  askFileShareFor: { build: (c) => c.post('/api/files/shared/AAAAAAAAAAAAAAAAAAAAAA/ask-for', { people: ['someone'] }), scope: 'nobody' },
  answerFileRequest: { build: (c) => c.post(`/api/files/requests/${crypto.randomUUID()}`, { answer: 'approve' }), scope: 'nobody' },
  // AI sharing (docs/decisions/20261116-ai-share-card-and-stop.md, 20261116-ai-share-who-can-open.md) and folder
  // sharing (the gate closed): an undo id, a step's next step and a shared folder's link that nobody made are 404 for
  // everyone; a share card's files read as `gone` for everyone but alice, with nothing about her file; the path-link
  // lookup answers everyone, null for alice's file (she opens it through her folder, nobody through a share)
  undoFileShares: { build: (c) => c.post('/api/files/shares/undo', { id: 'AAAAAAAAAAAAAAAAAAAAAA' }), scope: 'nobody' },
  // a take-back id nobody holds: 404 for everyone (a record is only ever its sharer's, once)
  takeBackFileShares: { build: (c) => c.post('/api/files/shares/take-back', { id: 'AAAAAAAAAAAAAAAAAAAAAA' }), scope: 'nobody' },
  runShareFix: { build: (c) => c.post(`/api/share-fixes/${crypto.randomUUID()}/run`, {}), scope: 'nobody' },
  sharedFolderList: { build: (c) => c.get('/api/files/shared/AAAAAAAAAAAAAAAAAAAAAA/list'), scope: 'nobody' },
  sharedFolderEntry: { build: (c) => c.get('/api/files/shared/AAAAAAAAAAAAAAAAAAAAAA/entry?sub=a.md'), scope: 'nobody' },
  shareCards: {
    build: async (c, w) => c.post('/api/files/shares/cards', { ids: [await aliceLink(w)] }), scope: 'self',
    check: (r, _w, who) => {
      nothingOfAlice(r.text, who, 'a share card')
      if (who !== 'memberIn' && r.status === 200 && r.json?.items?.[0]?.gone !== true) throw new Error(`${who}: a share card of alice's file was not gone`)
    },
  },
  grantedFileLink: {
    build: (c) => c.get('/api/files/granted-link?path=users%2Falice%2Ftodo.md'), scope: 'self',
    check: (r, _w, who) => { if (r.status === 200 && r.json?.id !== null) throw new Error(`${who}: the path link of alice's file answered a link id`) },
  },
  fileSharesCount: { build: (c) => c.get('/api/admin/file-shares'), scope: 'byLevel' },
  // the team owner's Remove all: an admin is refused (owner_only)
  removeAllFileShares: { build: (c) => c.del('/api/admin/file-shares'), scope: 'own-owner' },
}
