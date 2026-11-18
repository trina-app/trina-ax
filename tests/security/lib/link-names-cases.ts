import type { Spec } from './cases'
import { C, type Who, type World } from './world'

// Named app links (docs/decisions/20261118-named-app-links.md, server/src/link-names/resolve.ts): POST /api/link-names
// names a link only for a caller who could open the thing now. Every persona may call it (its own view), so the case
// aims it at alice's private things: her chat (in her personal project), that project, users/alice/todo.md and the
// folder users/alice/, and a link to that file (the request names the path, so only the names are checked there). Only
// alice gets names; the owner, an admin, other members and the person who must change the password first get
// `name: null` for each (or the password gate), never a canary; no session: 401.
// A missing chat answers exactly as a forbidden one. (Guests: tests/unit/b-link-names.test.ts, with a real guest.)

const links = new WeakMap<World, Promise<string>>()
/** alice's link to her own file (POST /api/files/link), made once per world */
function aliceLink(w: World): Promise<string> {
  let p = links.get(w)
  if (!p) links.set(w, (p = w.as.memberIn.ok('POST', '/api/files/link', { path: 'users/alice/todo.md' }).then((r) => r.id as string)))
  return p
}
const NOWHERE = '019a5f00-0000-7000-8000-0000000fffff'
/** what only alice may read in the answer (the file's name is in the request itself: checked by `name` below) */
const CANARIES = [C.aliceChatTitle, C.aliceFile, 'Private plan']

export const LINK_NAME_SPECS: Record<string, Spec> = {
  linkNames: {
    build: async (c, w) => c.post('/api/link-names', { links: [
      { kind: 'chat', id: w.ids.chatA },
      { kind: 'project', id: w.ids.projAlice },
      { kind: 'file', id: 'users/alice/todo.md' },
      { kind: 'folder', id: 'users/alice' },
      { kind: 'share', id: await aliceLink(w) },
      { kind: 'chat', id: NOWHERE },
    ] }),
    scope: 'self',
    check: (r, _w, who: Who) => {
      if (r.status !== 200) return
      const items = r.json.items as { kind: string; id: string; name: string | null; room?: unknown; folder?: true }[]
      if (items.length !== 6) throw new Error(`${who}: ${items.length} answers for 6 links`)
      // the missing chat: no name, and the same shape as a refused one
      const missing = JSON.stringify(Object.keys(items[5]!).sort())
      if (items[5]!.name !== null) throw new Error(`${who}: a missing chat got a name`)
      if (who === 'memberIn') {
        const names = items.slice(0, 5).map((x) => x.name)
        if (names[0] !== C.aliceChatTitle || names[1] !== 'Private plan' || names[2] !== 'todo.md' || names[3] !== 'alice' || names[4] !== 'todo.md')
          throw new Error(`alice did not get her own names: ${JSON.stringify(names)}`)
        return
      }
      for (const c of CANARIES) if (r.text.includes(c)) throw new Error(`${who}: link names showed alice's ${c}`)
      for (const x of items.slice(0, 5)) {
        if (x.name !== null) throw new Error(`${who}: alice's ${x.kind} was named`)
        if (JSON.stringify(Object.keys(x).sort()) !== missing) throw new Error(`${who}: alice's ${x.kind} answered unlike a missing one`)
      }
    },
  },
}
