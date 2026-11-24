// Sign in with Google, per client (docs/decisions/20261122-google-login-apps.md; server/src/auth/google-login.ts and
// google-login-apps.ts). A browser goes to Google in this window and comes back signed in (A1, a binding cookie). Google
// refuses to sign in inside the apps' own windows, so the desktop and phone apps open it in the system browser (the
// desktop's window handler) or the phone's auth session (google-signin-v1), and the return gives the app a one-time code.
// Only the secret this page keeps redeems it: a random secret made here, kept in this team page's sessionStorage (the
// desktop app reloads the page with the code, the same window and origin), and only its SHA-256 sent at the start.
// Pure rules and small helpers here, unit-tested in web/test/unit/google-sign-in.test.ts.
import { GOOGLE_SIGNIN_BRIDGE_VERSION } from '@mycel/shared'

export type GoogleSignInWay = 'web' | 'desktop' | 'mobile'

/** How this sign-in page offers Sign in with Google, or null (no button). A browser: where the server offers it at this
 * address (GET /api/setup googleSignIn). The desktop app: when the server offers it to the apps (googleAppSignIn) and
 * the app takes the code back (its bridge's googleSignIn); an older app shows the password only. The phone app: the
 * same with its capability google-signin-v1 (store builds before it show none). */
export function googleSignInWay(o: { client: GoogleSignInWay; googleSignIn?: boolean; googleAppSignIn?: boolean; desktopBridge?: number; phone?: boolean }): GoogleSignInWay | null {
  if (o.client === 'web') return o.googleSignIn ? 'web' : null
  if (!o.googleAppSignIn) return null
  if (o.client === 'desktop') return (o.desktopBridge ?? 0) >= GOOGLE_SIGNIN_BRIDGE_VERSION ? 'desktop' : null
  return o.phone ? 'mobile' : null
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A new secret: 32 random bytes, base64url (43 characters, the server's token shape). */
export function newAppSecret(random: (b: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return toBase64Url(random(new Uint8Array(32)))
}

/** What the start gets instead of the secret: its SHA-256 in hex (the server's hashToken). */
export async function appSecretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** One sign-in on its way in this tab: the secret, the app it is for, where to go after (the sign-in page's ?next=), and
 * when it began (a flow lives 10 minutes at the server, a code 5 more). */
export interface KeptGoogleSignIn { secret: string; client: 'desktop' | 'mobile'; next: string | null; at: number }
const KEY = 'mycel.googleSignIn'
const KEEP_MS = 20 * 60_000
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const session = (): Store | null => { try { return window.sessionStorage } catch { return null } }

/** Keep it for the page that redeems (a newer press replaces it). False: this tab cannot keep it (no sessionStorage). */
export function keepGoogleSignIn(k: KeptGoogleSignIn, store: Store | null = session()): boolean {
  try { store?.setItem(KEY, JSON.stringify(k)); return !!store } catch { return false }
}

/** The kept sign-in for this kind of app, taken out (used once), or null: none, another app's, or too old. */
export function takeGoogleSignIn(client: 'desktop' | 'mobile', now: number = Date.now(), store: Store | null = session()): KeptGoogleSignIn | null {
  let raw: string | null = null
  try { raw = store?.getItem(KEY) ?? null; store?.removeItem(KEY) } catch { return null }
  if (!raw) return null
  try {
    const k = JSON.parse(raw) as Partial<KeptGoogleSignIn>
    if (k.client !== client || typeof k.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(k.secret) || typeof k.at !== 'number' || now - k.at < 0 || now - k.at > KEEP_MS) return null
    return { secret: k.secret, client, next: typeof k.next === 'string' ? k.next : null, at: k.at }
  } catch { return null }
}

/** The code in /login/google's address (`#code=<43 characters>`, the desktop app's link), or null. */
export function readGoogleCode(hash: string): string | null {
  return /^#code=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? null
}

/** Where the redeemed sign-in goes: the sign-in page with its ?next=, so the router lands there as after a password. */
export const afterGoogleSignIn = (next: string | null): string => `/login${next ? `?next=${encodeURIComponent(next)}` : ''}`
