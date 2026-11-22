// The desktop app's half of a Google sign-in hand-off (desktop/src/common/sign-in-handoff.ts). Owner 2026-11-22 on
// 0.7.0: a team Drive share started in the desktop app, Google answered, the return page opened the app, and the
// dialog stayed on "Waiting for Google…" four times out of five. The app sent the code once and never read the answer:
// one lost POST and the result waited unclaimed, with nothing in the app's log.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAIM_RETRY_MS, deliverSignInCode } from '../../desktop/src/common/sign-in-handoff'
import { signInCode } from '../../desktop/src/common/address'
import { appLink } from '../../server/src/integrations/google-drive/app-return'

const CODE = 'c0deC0de_-c0deC0de_-c0deC0de_-c0deC0de_-abc'
const TEAM = 'https://totoro.trina.app'

function run(answers: (number | Error)[]) {
  const posts: string[] = [], lines: string[] = [], waits: number[] = []
  const done = deliverSignInCode({
    origin: TEAM, code: CODE, log: (l) => lines.push(l), wait: async (ms) => { waits.push(ms) },
    post: async (o, c) => { posts.push(`${o} ${c}`); const a = answers.shift() ?? 0; if (a instanceof Error) throw a; return a },
  })
  return { done, posts, lines, waits }
}

test('the owner\'s link for the team on screen gives the code', () => {
  expect(signInCode(appLink(TEAM, CODE), TEAM)).toBe(CODE)
})

test('six teams stored (the owner\'s app): the link finishes only in the team on screen, whichever that is', () => {
  const teams = ['http://localhost:19100', 'https://potenlab.trina.app', 'https://qa.trina.app', 'https://diontest.trina.app', 'https://dioncafe.trina.app', TEAM]
  for (const shown of teams) {
    for (const linked of teams.filter((t) => t.startsWith('https:'))) {
      expect(signInCode(appLink(linked, CODE), shown)).toBe(linked === shown ? CODE : null)
    }
  }
  // a plain-http link (this machine) never: a web page must not point the app at a local port
  expect(signInCode(appLink('http://localhost:19100', CODE), 'http://localhost:19100')).toBeNull()
})

test('REPRO: a first POST that gets no answer (relay hiccup, timeout) is sent again, and the sign-in finishes', async () => {
  const r = run([new Error('net::ERR_CONNECTION_RESET'), 502, 200])
  expect(await r.done).toBe('claimed')
  expect(r.posts).toEqual([`${TEAM} ${CODE}`, `${TEAM} ${CODE}`, `${TEAM} ${CODE}`])
  expect(r.waits).toEqual(CLAIM_RETRY_MS.slice(0, 2))
})

test('the server\'s refusal stands: an unknown, used or late code, another session, is not sent again', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const r = run([status, 200])
    expect(await r.done).toBe('refused')
    expect(r.posts.length).toBe(1)
  }
})

test('no answer at all: a few tries within the code\'s five minutes, then lost', async () => {
  const r = run([])
  expect(await r.done).toBe('lost')
  expect(r.posts.length).toBe(CLAIM_RETRY_MS.length + 1)
  expect(CLAIM_RETRY_MS.reduce((a, b) => a + b, 0)).toBeLessThan(60_000)
})

test('every try is logged with the team and the answer, never the code', async () => {
  const r = run([503, 200])
  await r.done
  expect(r.lines).toEqual([`sign-in hand-off: ${TEAM} try 1: 503 (lost)`, `sign-in hand-off: ${TEAM} try 2: 200 (claimed)`])
  expect(r.lines.join('\n')).not.toContain(CODE)
})

test('the app window posts through it, with its own session, and logs the link\'s team', () => {
  const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
  const claim = win.slice(win.indexOf('  private async claimSignIn('), win.indexOf('  offerLink(raw: string) {'))
  expect(claim).toContain('await deliverSignInCode({')
  expect(claim).toContain('const ses = app.webContents.session')
  expect(claim).toContain('ses.fetch(o + API.claimDriveFlow.path')
  expect(claim).not.toMatch(/handoffLog\([^)]*\bc(ode)?\b\)/)
  const offer = win.slice(win.indexOf('  offerLink(raw: string) {'), win.indexOf('  async answerLink('))
  expect(offer).toContain('const code = this.app ? signInCode(raw, this.team?.origin) : null')
  expect(offer).toContain("handoffLog(`sign-in hand-off: link for the team on screen")
})
