// The pair page the desktop app opens in a browser profile (docs/decisions/20261128-chrome-app-led-linking.md):
// chrome-extension://<id>/pair.html#nonce=<nonce>. It makes a PKCE pair, hands the nonce and the challenge to the app's
// native helper (Chrome starts it for our extension ids only), gets a one-time code for the team on the app's screen,
// spends it with the verifier as the in-profile Connect does, tells the app (its notice with Undo) and closes itself.
// No click. The nonce leaves the address at once; the verifier never leaves this page.
import { CHROME_NATIVE_HOST, ChromeNativeReply, ChromePairNonce } from '../../shared/src/chrome-native'
import { pkcePair } from './ids'
import { t, uiLanguage, useLocale } from './i18n'
import { FAILURE_TEXT, nativeFailure, type PairFailure } from './pair-errors'
import { redeem, teamOrigin } from './pairing'
import { loadLink } from './state'

const app = document.getElementById('app')!

function show(title: string, body?: string, error = false) {
  const h = document.createElement('h1')
  h.textContent = title
  app.replaceChildren(h)
  if (body) {
    const p = document.createElement('p')
    p.textContent = body
    if (error) p.className = 'error'
    app.append(p)
  }
}

async function ask(msg: unknown): Promise<ChromeNativeReply | { type: 'failed'; why: PairFailure }> {
  try {
    const r = ChromeNativeReply.safeParse(await chrome.runtime.sendNativeMessage(CHROME_NATIVE_HOST, msg))
    return r.success ? r.data : { type: 'error', reason: 'refused' }
  } catch (e) {
    // Chrome could not start or talk to the helper: say which, not "the app is not running"
    return { type: 'failed', why: nativeFailure(String((e as Error)?.message ?? e)) }
  }
}

async function closeSoon() {
  const tab = await chrome.tabs.getCurrent().catch(() => undefined)
  setTimeout(() => { if (tab?.id !== undefined) void chrome.tabs.remove(tab.id).catch(() => {}); else window.close() }, 2500)
}

async function start() {
  // the language of the team this browser answered before, if any (else the browser's)
  useLocale((await loadLink().catch(() => null))?.locale)
  document.documentElement.lang = uiLanguage()
  document.title = t('extName')
  const nonce = new URLSearchParams(location.hash.replace(/^#/, '')).get('nonce')
  // out of the address (history, a copied link) before anything else
  history.replaceState(null, '', location.pathname)
  if (!nonce || !ChromePairNonce.safeParse(nonce).success) return show(t('pairAppTitle'), t('pairAppExpired'))
  show(t('pairAppWorking'))
  const { verifier, challenge } = await pkcePair()
  const r = await ask({ type: 'pair', nonce, challenge })
  if (r.type !== 'code') {
    const why: PairFailure = r.type === 'error' ? r.reason : r.type === 'failed' ? r.why : 'refused'
    return show(t('pairAppTitle'), t(FAILURE_TEXT[why]), true)
  }
  const origin = teamOrigin(r.origin)
  if (!origin) return show(t('pairAppTitle'), t('pairFailed'), true)
  const got = await redeem(origin, r.code, verifier, r.label, r.email ? { email: r.email } : {})
  if (got !== 'linked') return show(t('pairAppTitle'), got === 'full' ? t('linksFull') : t('pairFailed'), true)
  // the worker connects with the new link; the app shows its notice with Undo
  await chrome.runtime.sendMessage({ type: 'linked' }).catch(() => {})
  const link = (await chrome.storage.local.get('link')).link as { linkId?: string; user?: { name?: string } } | undefined
  if (link?.linkId) await ask({ type: 'linked', nonce, linkId: link.linkId })
  // the team and its address in plain sight: the person sees where this browser now answers
  show(t('pairAppDone', [`${r.team} (${new URL(origin).host})`]), t('pairAppDoneBody', [r.label]))
  await closeSoon()
}

void start()
