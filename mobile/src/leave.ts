// Leaving a team on this phone signs out of it (QA TC-369: the WebView kept the old team's session cookie, and switching
// back opened that team signed in). Pure, no native imports: tests load this file.
import type { Slot } from './device'

/** How long the switch waits for the old team's sign-out answer before it goes on without one. */
export const LEAVE_WAIT_MS = 4000
const MAX_OWED = 8

/** The server ended the session (204) or there was none (401). */
export const ended = (status: number) => status === 204 || status === 401

/** Empties the page's own storage: local and session storage, the cookies script can reach, Cache Storage, IndexedDB and
 * service workers. The session cookie is HttpOnly: the sign-out's answer clears it, and the app clears it natively. */
export const WIPE_JS = 'try{localStorage.clear()}catch(e){}try{sessionStorage.clear()}catch(e){}'
  + "try{document.cookie.split(';').forEach(function(c){var n=c.split('=')[0].trim();if(n)document.cookie=n+'=; Max-Age=0; Path=/'})}catch(e){}"
  + 'try{if(window.caches)caches.keys().then(function(k){k.forEach(function(x){caches.delete(x)})},function(){})}catch(e){}'
  + 'try{if(window.indexedDB&&indexedDB.databases)indexedDB.databases().then(function(d){d.forEach(function(x){if(x.name)indexedDB.deleteDatabase(x.name)})},function(){})}catch(e){}'
  + 'try{if(navigator.serviceWorker)navigator.serviceWorker.getRegistrations().then(function(r){r.forEach(function(x){x.unregister()})},function(){})}catch(e){}'

/** The script for the team page being left: storage first (the page may be gone before the server answers), then
 * POST <team>/api/auth/logout with the page's own session, the status back to the app with the one-time token. */
export function leaveScript(origin: string, token: string): string {
  return `(function(){${WIPE_JS}`
    + `fetch(${JSON.stringify(`${origin}/api/auth/logout`)},{method:'POST',credentials:'same-origin',headers:{'x-mycel-csrf':'1'}})`
    + '.then(function(r){return r.status},function(){return 0}).then(function(s){'
    + `try{window.ReactNativeWebView.postMessage(JSON.stringify({mycelLeave:${JSON.stringify(token)},status:s}))}catch(e){}})})();true;`
}

/** The status in the leave script's answer for `token`, or null when the message is something else. */
export function readLeaveAnswer(raw: string, token: string | null): number | null {
  if (!token || raw.length > 300 || !raw.includes('mycelLeave')) return null
  try {
    const m = JSON.parse(raw) as { mycelLeave?: unknown; status?: unknown }
    return m && m.mycelLeave === token && typeof m.status === 'number' ? m.status : null
  } catch { return null }
}

/** One leave sign-out at a time on a team page: `start` injects the script and always resolves, with the server's status,
 * or 0 when the wait ran out, a newer start replaced it, or the page went (`cancel`). */
export class LeaveAsk {
  private pending: { token: string; done: (status: number) => void } | null = null
  constructor(private newToken: () => string, private wait = LEAVE_WAIT_MS) {}
  start(origin: string, inject: (script: string) => void): Promise<number> {
    this.cancel()
    return new Promise<number>(resolve => {
      const token = this.newToken()
      let settled = false
      const done = (status: number) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (this.pending?.token === token) this.pending = null
        resolve(status)
      }
      const timer = setTimeout(() => done(0), this.wait)
      this.pending = { token, done }
      try { inject(leaveScript(origin, token)) } catch { done(0) }
    })
  }
  /** A message from the page: true when it was the pending sign-out's answer (then it is not a bridge message). */
  answer(raw: string): boolean {
    const p = this.pending
    const status = p ? readLeaveAnswer(raw, p.token) : null
    if (status === null || !p) return false
    p.done(status)
    return true
  }
  cancel() { this.pending?.done(0) }
}

/** Teams left whose server has not confirmed the sign-out: the next visit to one signs out first. */
async function read(slot: Slot): Promise<string[]> {
  try { const v = JSON.parse((await slot.get()) ?? '[]'); return Array.isArray(v) ? v.filter((o): o is string => typeof o === 'string') : [] } catch { return [] }
}
export async function oweSignOut(slot: Slot, origin: string): Promise<void> {
  const list = (await read(slot)).filter(o => o !== origin)
  await slot.set(JSON.stringify([...list, origin].slice(-MAX_OWED)))
}
export async function signedOut(slot: Slot, origin: string): Promise<void> {
  const list = await read(slot)
  if (!list.includes(origin)) return
  const left = list.filter(o => o !== origin)
  await slot.set(left.length ? JSON.stringify(left) : null)
}
export async function owesSignOut(slot: Slot, origin: string): Promise<boolean> {
  return (await read(slot)).includes(origin)
}
