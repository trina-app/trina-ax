// Small pure helpers: the AI's tab ids ("c<chrome tab id>") and the pairing's PKCE pair. Unit-tested in
// tests/unit/chrome-ext-ids.test.ts.

/** The id the AI sees for a Chrome tab. */
export const aiTabId = (chromeTabId: number) => `c${chromeTabId}`

/** The Chrome tab id behind an AI tab id ("c123", also a bare number the model sent), or null. */
export function parseAiTabId(id: string | undefined): number | null {
  if (id === undefined) return null
  const m = /^c?(\d{1,10})$/.exec(String(id).trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A fresh verifier (32 random bytes, base64url: 43 characters) and its challenge (base64url sha256 of the verifier). */
export async function pkcePair(random: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(random)
  return { verifier, challenge: await pkceChallenge(verifier) }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The code in the done page's fragment (`#code=…`), or null. */
export function codeFromDoneUrl(url: string, origin: string, donePath: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.origin !== origin || u.pathname !== donePath) return null
  const code = new URLSearchParams(u.hash.replace(/^#/, '')).get('code')
  return code && /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null
}

/** "Chrome on Mac", "Edge on Windows", "Brave on Linux": what the person's team list calls this browser. */
export function browserLabel(ua: string, data?: { brands?: { brand: string }[]; platform?: string }, brave = false): string {
  const brands = (data?.brands ?? []).map((b) => b.brand)
  const browser = brave || brands.includes('Brave') ? 'Brave' : brands.includes('Microsoft Edge') || / Edg\//.test(ua) ? 'Edge' : 'Chrome'
  const p = (data?.platform ?? '').toLowerCase()
  const os = p.includes('mac') || /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : p.includes('win') || /Windows/.test(ua) ? 'Windows'
    : p.includes('chrome os') || /CrOS/.test(ua) ? 'ChromeOS'
    : p.includes('linux') || /Linux/.test(ua) ? 'Linux'
    : 'a computer'
  return `${browser} on ${os}`
}
