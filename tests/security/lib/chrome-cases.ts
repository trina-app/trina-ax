import type { Spec } from './cases'
/** The AI's browser in the person's own Chrome (server/src/routes/chrome.ts; docs/decisions/20261128-trina-in-chrome.md).
 * Pairing, a link of another person, the extension's socket and the tickets are in tests/unit/chrome-link.test.ts. */
const challenge = 'C'.repeat(43)
export const CHROME_SPECS: Record<string, Spec> = {
  chromeLinks: { build: (c) => c.get('/api/chrome/links'), scope: 'self' },
  // a link that is not the caller's (or none): the same 404 for everyone
  chromeUnlink: { build: (c) => c.del('/api/chrome/links/no-such-link'), scope: 'nobody' },
  chromeTarget: { build: (c) => c.put('/api/chrome/target', { target: 'app' }), scope: 'self' },
  chromePair: { build: (c) => c.post('/api/chrome/pair', { challenge }), scope: 'byLevel' },
  // a made-up code links nothing, for anyone
  chromeRedeem: { skipPositive: true, build: (c) => c.post('/api/chrome/redeem', { code: 'A'.repeat(43), verifier: 'B'.repeat(43), label: 'x', version: '1' }), scope: 'byLevel',
    check: (r, _w, who) => { if (r.status < 300) throw new Error(`${who}: a made-up Chrome code made a link: ${r.text}`) } },
  // a made-up ticket without a link token: 404 for anyone
  chromeUpload: { skipPositive: true, build: (c) => c.get(`/api/chrome/uploads/${'A'.repeat(43)}`), scope: 'byLevel',
    check: (r, _w, who) => { if (r.status < 300) throw new Error(`${who}: a Chrome upload ticket was served without its link: ${r.text}`) } },
}
/** the extension's socket: tests/unit/chrome-link.test.ts (an unknown token, a page's origin, no auth frame) */
export const CHROME_RAW_COVERED = ['RAW GET CHROME_WS_PATH']
