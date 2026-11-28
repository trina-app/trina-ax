// Linking this Chrome to a team, PKCE style (docs/decisions/20261128-trina-in-chrome.md "Rule, the link"): the
// extension keeps a secret verifier and opens the team's /connect-chrome page with its sha256 (the challenge). The
// signed-in team page asks the person and moves its tab to /connect-chrome/done#code=…; the extension reads that tab's
// address (it has access to the team origin only), closes the tab and spends the code with the verifier. A copied
// address or code is useless anywhere else. A pending pairing ends after 5 minutes or when its tab closes.
import { CHROME_CONNECT_DONE_PATH, CHROME_CONNECT_PATH, ChromeRedeemed } from '../../shared/src/api/chrome'
import { browserLabel, codeFromDoneUrl, pkcePair } from './ids'
import { cutLabel } from '../../shared/src/chrome-native'
import { loadLink, saveLink } from './state'

const PAIR_TTL_MS = 5 * 60_000

interface Pending {
  origin: string
  /** the name the person gave this browser profile */
  label: string
  verifier: string
  tabId: number
  startedAt: number
}
export type PairState = { state: 'none' } | { state: 'waiting'; origin: string } | { state: 'failed'; full?: true }

async function pending(): Promise<Pending | null> {
  const p = (await chrome.storage.session.get('pair')).pair as Pending | undefined
  if (!p) return null
  if (Date.now() - p.startedAt > PAIR_TTL_MS) {
    await drop(p, false)
    return null
  }
  return p
}

async function drop(p: Pending | null, failed: boolean) {
  await chrome.storage.session.remove('pair')
  await chrome.storage.session.set({ pairFailed: failed })
  if (p) await chrome.tabs.remove(p.tabId).catch(() => {})
}

export async function pairState(): Promise<PairState> {
  const p = await pending()
  if (p) return { state: 'waiting', origin: p.origin }
  const f = (await chrome.storage.session.get('pairFailed')).pairFailed
  return f === 'full' ? { state: 'failed', full: true } : f ? { state: 'failed' } : { state: 'none' }
}

/** The name of this browser profile as the team lists it: 1 to 60 characters, the browser and system when left empty. */
export function cleanLabel(raw: string): string {
  const v = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
  return cutLabel(v) || browserLabel(navigator.userAgent, navigator.userAgentData, Boolean(navigator.brave))
}

/** A team origin the extension may connect to: https, or a developer's http://localhost. */
export function teamOrigin(raw: string): string | null {
  let u: URL
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`)
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return u.origin
  return null
}

/** Start pairing with a team (the popup already got the host permission for it). */
export async function startPairing(origin: string, label: string): Promise<void> {
  const old = await pending()
  // the same start twice (the grant and the popup's own message): one tab
  if (old && old.origin === origin && Date.now() - old.startedAt < 10_000) return
  if (old) await drop(old, false)
  const { verifier, challenge } = await pkcePair()
  const tab = await chrome.tabs.create({ url: `${origin}${CHROME_CONNECT_PATH}?challenge=${encodeURIComponent(challenge)}`, active: true })
  await chrome.storage.session.set({ pair: { origin, label: cleanLabel(label), verifier, tabId: tab.id!, startedAt: Date.now() } satisfies Pending, pairFailed: false })
}

export async function cancelPairing(): Promise<void> {
  const p = await pending()
  await chrome.storage.session.remove('pair')
  await chrome.storage.session.set({ pairFailed: false })
  if (p) await chrome.tabs.remove(p.tabId).catch(() => {})
}

/** The pairing tab's address changed: on the done page, spend the code. */
async function onTabUrl(tabId: number, url: string, onLinked: () => Promise<void>) {
  const p = await pending()
  if (!p || p.tabId !== tabId) return
  if (!url.startsWith(`${p.origin}${CHROME_CONNECT_DONE_PATH}`)) return
  const code = codeFromDoneUrl(url, p.origin, CHROME_CONNECT_DONE_PATH)
  await chrome.storage.session.remove('pair')
  await chrome.tabs.remove(tabId).catch(() => {})
  if (!code) return void (await chrome.storage.session.set({ pairFailed: true }))
  const r = await redeem(p.origin, code, p.verifier, p.label)
  await chrome.storage.session.set({ pairFailed: r === 'linked' ? false : r })
  if (r === 'linked') await onLinked()
}

/**
 * Spend a code with the verifier at the team and keep the link (the in-profile Connect and the desktop app's pair page,
 * pair.ts). 'full': the person has CHROME_LINKS_MAX browsers linked; true: anything else that failed (a used, expired
 * or wrong code: 410; no answer).
 */
export async function redeem(origin: string, code: string, verifier: string, label: string, extra: { email?: string } = {}): Promise<'linked' | 'full' | true> {
  // the link this install already holds (same team): replaced, not a second row for one profile
  const held = await loadLink()
  const previous = held && held.origin === origin ? held.token : undefined
  try {
    // no cookies: a profile linked through the desktop app has no access to the team's address (the server answers this
    // one path to extensions: CORS); the code and the verifier are the whole proof
    const res = await fetch(`${origin}/api/chrome/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({
        code,
        verifier,
        label,
        version: chrome.runtime.getManifest().version,
        ...(previous ? { previous } : {}),
        ...(extra.email ? { email: extra.email } : {}),
        browser: browserLabel(navigator.userAgent, navigator.userAgentData, Boolean(navigator.brave)),
      }),
    })
    if (res.status === 409) return 'full'
    if (!res.ok) return true
    const r = ChromeRedeemed.parse(await res.json())
    await saveLink({ origin, token: r.token, linkId: r.linkId, user: r.user, team: r.team, label, teamHosts: r.teamHosts })
    return 'linked'
  } catch {
    return true
  }
}

/** The popup is about to ask Chrome for access to this team address. */
export async function wantPairing(origin: string, label: string): Promise<void> {
  await chrome.storage.session.set({ want: { origin, label, at: Date.now() } })
}

export function installPairingListeners(onLinked: () => Promise<void>) {
  // Chrome granted the team address (the popup may have closed while it asked): pairing starts here
  chrome.permissions.onAdded.addListener((p) => {
    void (async () => {
      const want = (await chrome.storage.session.get('want')).want as { origin: string; label: string; at: number } | undefined
      if (!want || Date.now() - want.at > 120_000) return
      const host = new URL(want.origin)
      if (!(p.origins ?? []).includes(`${host.protocol}//${host.hostname}/*`)) return
      await chrome.storage.session.remove('want')
      await startPairing(want.origin, want.label)
    })()
  })
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) void onTabUrl(tabId, change.url, onLinked)
  })
  chrome.tabs.onRemoved.addListener((tabId) => {
    void pending().then((p) => {
      if (p?.tabId === tabId) void chrome.storage.session.remove('pair')
    })
  })
}
