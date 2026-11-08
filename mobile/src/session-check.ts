// Whether the team page on screen has someone signed in, asked by the app itself (GET /api/me from the page, the
// WebView's own cookies): until it answers yes, the app keeps the team address and "다른 팀에 연결" under the page on
// every page, not only the sign-in pages (a page can look like a sign-in page at any address: `/`, `/signin`). Pure, no
// native imports: tests load this file directly.

/** The script injected into the team page: one GET /api/me, the answer posted back with this check's number. */
export function sessionCheckScript(n: number): string {
  const post = (ok: string) => `window.ReactNativeWebView.postMessage(JSON.stringify({mycelSessionCheck:${n},ok:${ok}}))`
  return `(function(){try{fetch('/api/me',{credentials:'same-origin',headers:{accept:'application/json'}}).then(function(r){${post('r.ok')}},function(){${post('false')}})}catch(e){}})();true;`
}

/** The answer to check `n`, or null when the message is something else (a bridge message) or an older check's. */
export function readSessionCheck(data: string, n: number): boolean | null {
  if (data.length > 200 || !data.includes('mycelSessionCheck')) return null
  try {
    const m = JSON.parse(data) as { mycelSessionCheck?: unknown; ok?: unknown }
    return m && m.mycelSessionCheck === n && typeof m.ok === 'boolean' ? m.ok : null
  } catch {
    return null
  }
}
