// Sign up with Google on the web (server/src/auth/google-signup.ts): the setup, invite and team link pages go to Google
// in this window, and Google's return comes back here signed in, or to the page with ?google=<result>. The server never
// puts a token in that address, so this tab keeps what the page needs to try again: the invite page's own address (its
// token is in it), and the username and name the person typed. The team link's token and the setup token are kept by
// their own pages already (lib/team-link.ts, lib/setupLink.ts). Signed in afterwards, the kept tokens are forgotten.
import { forgetSetupToken } from './setupLink'
import { forgetJoinToken } from './team-link'

const KEY = 'mycel.googleSignUp'
/** a Google flow lasts 10 minutes on the server; a little longer here, then the page starts afresh */
const KEEP_MS = 15 * 60_000

export type SignUpPage = 'setup' | 'invite' | 'join'
export interface PendingSignUp {
  page: SignUpPage
  /** the invite page's address (/invite/<token>), for the way back from /invite */
  path?: string
  username?: string
  name?: string
  at: number
}

/** Right before the page goes to Google. */
export function keepGoogleSignUp(p: Omit<PendingSignUp, 'at'>): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ ...p, at: Date.now() })) } catch { /* storage blocked: the page starts empty */ }
}

/** The sign-up this tab started on `page`, while it is fresh; null otherwise. Kept for a reload. */
export function pendingGoogleSignUp(page: SignUpPage, now = Date.now()): PendingSignUp | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<PendingSignUp> | null
    if (!v || v.page !== page || typeof v.at !== 'number' || now - v.at > KEEP_MS || now < v.at) return null
    const s = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : undefined)
    const path = s(v.path, 300)
    return { page, at: v.at, ...(path && /^\/invite\/[A-Za-z0-9_-]{16,200}$/.test(path) ? { path } : {}), ...(s(v.username, 64) ? { username: s(v.username, 64) } : {}), ...(s(v.name, 100) ? { name: s(v.name, 100) } : {}) }
  } catch { return null }
}

/** Signed in (store/session.ts): a sign-up that worked, or a Google account that was already someone's here. The tokens
 * this tab kept for a retry are spent or not needed. Nothing happens when no sign-up was started here. */
export function googleSignUpDone(): void {
  try {
    if (!sessionStorage.getItem(KEY)) return
    sessionStorage.removeItem(KEY)
  } catch { return }
  forgetJoinToken()
  forgetSetupToken()
}

/** ?google=<result> of a page Google's return came back to, or null. */
export const googleResultOf = (search: string): string | null => new URLSearchParams(search).get('google')
