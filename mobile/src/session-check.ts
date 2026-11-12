// Whether the team page on screen has someone signed in, asked by the app itself (GET /api/me from the page, the
// WebView's own cookies): until it answers yes, the app keeps the team address and "다른 팀에 연결" under the page on
// every page, not only the sign-in pages (a page can look like a sign-in page at any address: `/`, `/signin`). Pure, no
// native imports: tests load this file directly.

/** The script injected into the team page: one GET /api/me, its status posted back with this check's number (0 when the
 * request itself failed: offline, a dropped connection). */
export function sessionCheckScript(n: number): string {
  const post = (status: string) => `window.ReactNativeWebView.postMessage(JSON.stringify({mycelSessionCheck:${n},status:${status}}))`
  return `(function(){try{fetch('/api/me',{credentials:'same-origin',headers:{accept:'application/json'}}).then(function(r){${post('r.status')}},function(){${post('0')}})}catch(e){}})();true;`
}

/** What a check said: 'in' (someone is signed in), 'out' (the team said no one is: 401/403), or 'unknown' (anything
 * else: a network blip on a phone's mobile data, a relay or tunnel 502, a 429), which must not count as signed out or
 * the team line comes up under a signed-in page until the next check. */
export type SessionAnswer = 'in' | 'out' | 'unknown'

/** The answer to check `n`, or null when the message is something else (a bridge message) or an older check's. */
export function readSessionCheck(data: string, n: number): SessionAnswer | null {
  if (data.length > 200 || !data.includes('mycelSessionCheck')) return null
  try {
    const m = JSON.parse(data) as { mycelSessionCheck?: unknown; status?: unknown }
    if (!m || m.mycelSessionCheck !== n || typeof m.status !== 'number' || !Number.isInteger(m.status)) return null
    if (m.status >= 200 && m.status < 300) return 'in'
    return m.status === 401 || m.status === 403 ? 'out' : 'unknown'
  } catch {
    return null
  }
}
