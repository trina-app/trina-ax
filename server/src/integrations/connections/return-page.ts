// The page a browser sees when a service sends it back after a connector sign-in (routes/integrations.ts for every
// connection, routes/slack.ts for Slack): one card, light or dark as the system is, readable at phone width, the Google
// return page's own style allowed by its hash. A desktop sign-in held for the app on this computer (the one-time code
// only in the FRAGMENT of the app's own link) and the same return opened again ("waiting for the app") are the same
// page for every connector (docs/decisions/20261121-connect-browser-handoff.md, 20261122-slack-desktop-handoff.md).
import crypto from 'node:crypto'
import type { Context } from 'hono'
import { PRODUCT } from '@mycel/shared'
import type { Locale } from '@mycel/shared/api'
import { appLink, heldLink } from '../google-drive/app-return'
import { RETURN_STYLE, RETURN_STYLE_SRC } from '../google-drive/callback-page'
import { say } from './text'

const CLOSE = 'window.close()'
const CLOSE_HASH = 'sha256-' + crypto.createHash('sha256').update(CLOSE).digest('base64')
/** the one script a return page may run: it tries to close the window (the app watches the sign-in itself) */
export const CLOSE_SCRIPT = `<script>${CLOSE}</script>`
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)

/** no cache, no referrer; only its own style, the product mark from this server and the closing script */
export function returnHeaders(c: Context) {
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
  c.header('Content-Security-Policy', `default-src 'none'; style-src ${RETURN_STYLE_SRC}; img-src 'self'; script-src '${CLOSE_HASH}'; frame-ancestors 'none'`)
}

/** a heading, plain words and one next step (static text and same-origin or app links only) */
export function returnPage(L: Locale, o: { title: string; text: string; extra?: string; cta?: { href: string; label: string; testid?: string }; head?: string; tail?: string }): string {
  return `<!doctype html><html lang="${L}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(say('callbackTitle', L))}</title>${o.head ?? ''}<style>${RETURN_STYLE}</style>`
    + `<main><img class="logo" src="/favicon.svg" alt="${esc(PRODUCT.displayName)}" width="40" height="40"><h1>${esc(o.title)}</h1><p role="status">${esc(o.text)}</p>${o.extra ?? ''}`
    + (o.cta ? `<a class="cta" href="${esc(o.cta.href)}"${o.cta.testid ? ` data-testid="${o.cta.testid}"` : ''}>${esc(o.cta.label)}</a>` : '') + `${o.tail ?? ''}</main>`
}

/** "Back to the app" without a code: brings the desktop app forward */
export const backToApp = (L: Locale, origin: string) => ({ href: appLink(origin), label: say('callbackBackToApp', L) })

/** A desktop sign-in held for the app on this computer: the one-time code only in the fragment of the app's own link
 * (no server, proxy or log sees it), opened by itself and by the button. It names whose account it joins, so a person
 * who did not start it sees it is not theirs. */
export function heldPage(L: Locale, origin: string, held: { code: string; who: { name: string; username: string }; name: string; returnPort?: number | null }): string {
  const P = { product: PRODUCT.displayName }
  // the app's return address on 127.0.0.1 when its session said one, else the app link (app-return.ts heldLink)
  const link = heldLink(origin, held.code, held.returnPort)
  return returnPage(L, {
    head: `<meta http-equiv="refresh" content="0;url=${esc(link)}">`,
    title: say('callbackHeldTitle', L, P), text: say('callbackHeld', L, { name: held.name }),
    extra: held.who.username ? `<ul class="facts" data-testid="held-who"><li>${esc(say('callbackHeldWho', L, { ...P, person: held.who.name, username: held.who.username }))}</li></ul>` : '',
    cta: { href: link, label: say('callbackBackToApp', L), testid: 'held-back' },
    tail: (held.returnPort ? `<a class="alt" href="${esc(appLink(origin, held.code))}" data-testid="held-app-link">${esc(say('callbackOpenApp', L))}</a>` : '')
      + `<p class="note" data-testid="held-own-app">${esc(say('callbackHeldOwnApp', L, P))}</p>`,
  })
}

/** the same return opened again while the first one's code waits for the app: never a second code */
export function handedPage(L: Locale, origin: string): string {
  return returnPage(L, { title: say('callbackHeldTitle', L, { product: PRODUCT.displayName }), text: say('callbackHanded', L), cta: backToApp(L, origin) })
}
