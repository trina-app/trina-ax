import type { Spec } from './cases'
import { C, type Who } from './world'

// "Ask for access" on a chat's or project's link (docs/decisions/20261116-chat-project-ask-access.md,
// server/src/chat/access-requests.ts). The page's read answers everyone signed in (guests excepted), aimed at alice's
// own private chat (chatA) and her team project: alice opens them; everyone else, the owner and admins included, gets
// no_access with nothing of them (no title, no message, no name); the owner and admins open alice's team project as
// people who manage it. An ask or an answer on an id that does not exist is 4xx for everyone, and leaves no row.
const nothingOfAlice = (text: string, who: Who, what: string) => {
  if (who === 'memberIn') return
  for (const c of [C.aliceChatTitle, C.aliceMsg, C.aliceAnswer, C.aliceProjInstr]) if (text.includes(c)) throw new Error(`${who}: ${what} showed alice's chat or project`)
}

export const ACCESS_REQUEST_SPECS: Record<string, Spec> = {
  linkAccess: {
    build: (c, w) => c.get(`/api/link-access/chat/${w.ids.chatA}`), scope: 'self',
    check: (r, _w, who) => {
      nothingOfAlice(r.text, who, 'the chat link page')
      if (r.status !== 200) return
      const want = who === 'memberIn' ? 'open' : 'no_access'
      if (r.json?.status !== want) throw new Error(`${who}: alice's chat link answered ${r.json?.status}, not ${want}`)
      if (JSON.stringify(r.json).includes('alice') || JSON.stringify(r.json).includes('Alice')) throw new Error(`${who}: the chat link page named alice`)
    },
  },
  requestLinkAccess: { build: (c) => c.post(`/api/link-access/chat/${crypto.randomUUID()}/request`, {}), scope: 'nobody',
    check: (r, w, who) => {
      nothingOfAlice(r.text, who, 'an ask')
      const n = w.inst.ctx.db.query('SELECT COUNT(*) n FROM access_requests').get() as { n: number }
      if (n.n) throw new Error(`${who}: an ask on a missing chat left a request`)
    } },
  answerAccessRequest: { build: (c) => c.post(`/api/access-requests/${crypto.randomUUID()}`, { answer: 'approve' }), scope: 'nobody' },
}
