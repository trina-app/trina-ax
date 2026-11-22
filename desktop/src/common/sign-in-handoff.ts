// The desktop app's half of a Google sign-in hand-off (server google-drive/app-return.ts): the return page in the system
// browser opens `trina-ax://open?url=<team>/#code=<code>`, and the app posts the code to that team's claim address
// with its own session (the session that started the sign-in). Drive, the team Drive share, Gmail, Calendar, Docs,
// Sheets and app connections all finish here.
//
// Before (owner 2026-11-22, "Google Drive 공유" on a hosted team, 0.7.0): one POST, its answer never read, nothing
// logged. A refused or lost POST (a relay hiccup, a timeout, a 5xx) left the dialog on "Waiting for Google…" with no
// trace in the app. Now the answer is read, a lost POST is sent again a few times within the code's life, and each step
// is logged — never the code.
// Pure: no Electron. Unit-tested in tests/unit/e-desktop-signin-handoff.test.ts.

/** What the server answers, or 0 when no answer came (network, timeout). */
export type ClaimPost = (origin: string, code: string) => Promise<number>

/** The waits before each further try after a lost answer (no answer, 429, 5xx): about 25 s in all, well inside the
 * code's five minutes (server CLAIM_MS). */
export const CLAIM_RETRY_MS: readonly number[] = [1000, 3000, 8000, 13000]

export type ClaimResult = 'claimed' | 'refused' | 'lost'

/** A lost answer: worth trying again (the code is used up only by an answer 200). */
const lost = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500

/**
 * Post the code until the server answers: 200 claimed; another 4xx refused (unknown, used or late code, another session:
 * the server's answer stands and nothing is tried again); no answer, 408, 429 or 5xx: tried again after each wait in
 * `retry`, then lost. `log` gets one line per try, with the team's address and the answer, never the code.
 */
export async function deliverSignInCode(o: {
  origin: string
  code: string
  post: ClaimPost
  log: (line: string) => void
  wait?: (ms: number) => Promise<void>
  retry?: readonly number[]
}): Promise<ClaimResult> {
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const retry = o.retry ?? CLAIM_RETRY_MS
  for (let i = 0; ; i++) {
    let status = 0
    try {
      status = await o.post(o.origin, o.code)
    } catch {
      status = 0
    }
    const verdict: ClaimResult = status >= 200 && status < 300 ? 'claimed' : lost(status) ? 'lost' : 'refused'
    o.log(`sign-in hand-off: ${o.origin} try ${i + 1}: ${status || 'no answer'} (${verdict})`)
    if (verdict !== 'lost' || i >= retry.length) return verdict
    await wait(retry[i]!)
  }
}
