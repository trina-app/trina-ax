// App-led linking of the <app> in Chrome extension (docs/decisions/20261128-chrome-app-led-linking.md). The desktop app
// lists the browser profiles of this computer (each browser's Local State) and opens one on the extension's pair page
// with a nonce it minted (URL fragment). The page hands the nonce and its PKCE challenge to a small native helper that
// Chrome starts for our extension ids only (native messaging, allowed_origins); the helper passes them to the running
// app over a socket only this OS user can open; the app checks the nonce (single use, short-lived, bound to the profile
// it opened) and asks the signed-in team page for a one-time pair code bound to the challenge (POST /api/chrome/pair).
// The extension spends that code with its secret verifier as in the in-profile Connect. Native messaging is used only
// to pair: no link token or session ever crosses it, and browser calls stay on the team's WebSocket.
// Pure: no Node, no DOM (imported by the extension, the desktop app and the web page).
import { z } from 'zod'

/** Chrome's name for the helper (lowercase, dots and underscores); its manifest is `<name>.json`. */
export const CHROME_NATIVE_HOST = 'com.mycel.chrome_host'

/**
 * The extension ids the helper lets in (allowed_origins; never a wildcard). `chromeStore` / `edgeStore`: the Chrome Web
 * Store and Edge Add-ons items, filled in once each store gave its id (empty until then; the Chrome Web Store item,
 * unlisted, since 2026-11-28). `dev`: an unpacked build
 * (build.ts puts chrome-extension/dev-key.pub in its manifest, so its id is fixed). The dev id is public, so anyone could
 * load an unpacked extension with it: the desktop app allows it only in a development run (chromeExtensionIds(true)).
 */
export const CHROME_EXTENSION_IDS = { chromeStore: 'pfalalpmbomdafcmobbjlgekhdfjepmc', edgeStore: '', dev: 'mjajhjlbdnncdbjdmlncmhdpcombjjgk' } as const
const isId = (s: string) => /^[a-p]{32}$/.test(s)
export const chromeExtensionIds = (dev = false): string[] =>
  [CHROME_EXTENSION_IDS.chromeStore, CHROME_EXTENSION_IDS.edgeStore, ...(dev ? [CHROME_EXTENSION_IDS.dev] : [])].filter(isId)

/** The extension's store page for a browser (the store's search page until the store gave the item its id). */
export function chromeStoreUrl(browser: 'chrome' | 'edge' | 'brave'): string {
  if (browser === 'edge' && CHROME_EXTENSION_IDS.edgeStore) return `https://microsoftedge.microsoft.com/addons/detail/${CHROME_EXTENSION_IDS.edgeStore}`
  if (CHROME_EXTENSION_IDS.chromeStore) return `https://chromewebstore.google.com/detail/${CHROME_EXTENSION_IDS.chromeStore}`
  return 'https://chromewebstore.google.com/search/Trina%20AX'
}

/** The extension's pair page; the desktop app opens it as `chrome-extension://<id>/<PAIR_PAGE>#nonce=<nonce>`. */
export const CHROME_PAIR_PAGE = 'pair.html'
/** a nonce lives this long after the app opened the profile */
export const CHROME_PAIR_NONCE_TTL_MS = 2 * 60_000
/** a native message is at most this large either way (Chrome allows 1 MB to the helper; ours are tiny) */
export const CHROME_NATIVE_MAX_BYTES = 16 * 1024

/** 32 random bytes, base64url: a nonce, a challenge, a code */
const Secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const ChromePairNonce = Secret

/** extension -> helper -> app */
export const ChromeNativeRequest = z.discriminatedUnion('type', [
  /** link this profile: the nonce the app put in the pair page's address, and the extension's PKCE challenge */
  z.strictObject({ type: z.literal('pair'), nonce: Secret, challenge: Secret }),
  /** the extension spent the code: the app shows its notice with Undo (the same nonce, once, shortly after `pair`) */
  z.strictObject({ type: z.literal('linked'), nonce: Secret, linkId: z.string().min(1).max(100) }),
])
export type ChromeNativeRequest = z.infer<typeof ChromeNativeRequest>

/** why no code: the app is not running (the helper's own answer), the nonce is unknown, used or expired, no team page
 * is signed in on the app's screen, or the page said no (a guest, a limit) */
export const ChromeNativeRefusal = z.enum(['app_not_running', 'bad_nonce', 'no_team', 'refused'])
export type ChromeNativeRefusal = z.infer<typeof ChromeNativeRefusal>

/** app -> helper -> extension */
export const ChromeNativeReply = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('code'),
    /** the team the code is for: the extension spends it there */
    origin: z.string().max(300),
    code: Secret,
    team: z.string().max(200),
    /** the profile's name and account as the browser's Local State lists them, and "Chrome on Mac" */
    label: z.string().min(1).max(60).regex(/^[^\u0000-\u001f\u007f\u2028\u2029]+$/),
    email: z.string().max(254).optional(),
    browser: z.string().min(1).max(60),
  }),
  z.object({ type: z.literal('ok') }),
  z.object({ type: z.literal('error'), reason: ChromeNativeRefusal }),
])
export type ChromeNativeReply = z.infer<typeof ChromeNativeReply>

/** At most `max` UTF-16 units (what zod's .max counts), never a broken surrogate pair, trimmed. */
export function cutLabel(v: string, max = 60): string {
  let out = ''
  for (const ch of v) { if (out.length + ch.length > max) break; out += ch }
  return out.trim()
}

/** The name a profile gets: the browser's own name for it ("Work", "Person 1": what the browser's profile menu shows),
 * else "Chrome on Mac". Never the account's email (it shows next to the name, and only where the person sees it). At
 * most 60 UTF-16 units, no control characters. */
export function chromeProfileLabel(name: string | undefined, browser: string): string {
  const n = (name ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return cutLabel(n) || cutLabel(browser) || 'Chrome'
}
