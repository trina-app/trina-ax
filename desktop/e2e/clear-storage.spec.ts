// fix/desktop-clear-storage-hang (2026-11-11): on a busy Mac (macOS 26.6, Electron 44.7.2), `session.clearStorageData()`
// with no list never settled. The in-app browser clears its data when the person signs out or someone else signs in,
// and every AI browser call waits for that, so the in-app browser stopped for good; removing a team never finished.
// The clears now name their storage types and have a time limit (main/clear-session.ts). Here the stuck clear is put
// into the real app's main process, because it happens only while the Mac is overloaded (docs/DECISIONS.md).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { ACME, addTeam, answer, call, chrome, close, launch, newTurn, newUserData, result, run, SHOP, text, view, welcome } from './helpers'

// Cache Storage and service workers need a secure origin; shop.test is plain http in these tests
const SECURE_SHOP = [`--unsafely-treat-insecure-origin-as-secure=${SHOP}`]
const teams = (userData: string) => (JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8')) as { teams: { id: string }[] }).teams

/** What the app writes (console.warn of a clear that did not finish), whole lines however the output is chunked. */
function appLog(app: ElectronApplication): () => string[] {
  const out = { stdout: '', stderr: '' }
  app.process().stdout?.on('data', (d) => (out.stdout += String(d)))
  app.process().stderr?.on('data', (d) => (out.stderr += String(d)))
  return () => [...out.stdout.split('\n'), ...out.stderr.split('\n')]
}
const unfinished = (log: () => string[]) => log().filter((l) => l.includes('did not finish'))

type Stuck = 'no-list' | 'all'
/** Make the browser's clears hang in the main process: 'no-list' as seen on a busy Mac (a clear with no list of
 * storage types never settles, a list does), 'all' every clear of every session. */
async function stickClears(app: ElectronApplication, how: Stuck) {
  await app.evaluate(({ session }, how) => {
    const proto = Object.getPrototypeOf(session.defaultSession) as Record<string, (...a: unknown[]) => Promise<void>>
    const never = () => new Promise<void>(() => {})
    const storage = proto.clearStorageData
    proto.clearStorageData = function (this: unknown, ...a: unknown[]) {
      const opts = a[0] as { storages?: unknown } | undefined
      return how === 'all' || !Array.isArray(opts?.storages) ? never() : storage.apply(this, a)
    }
    if (how === 'all') {
      proto.clearCache = never
      proto.clearAuthCache = never
    }
  }, how)
}

/** A new turn: the AI opens `path` on the shop, and the person allows it once. */
async function openOnce(app: ElectronApplication, path: string) {
  newTurn()
  const { callId } = await call(ACME, 'navigate', { url: `${SHOP}${path}` })
  await answer(app, '이번만 허용', 'site')
  const r = await result(ACME, callId)
  expect(r.result.ok, text(r)).toBe(true)
}

/** What the shop page finds in the browser: cookie, localStorage, IndexedDB, Cache Storage, service workers. */
async function storedOnShop(app: ElectronApplication) {
  await openOnce(app, '/stored.html')
  let out = ''
  await expect.poll(async () => (out = text(await run(ACME, 'get_page_text'))), { timeout: 15_000 }).toContain('sw=[')
  return out
}

async function removeOnlyTeam(app: ElectronApplication, page: Awaited<ReturnType<typeof addTeam>>) {
  await page.evaluate(() => (window as any).mycelDesktop.openTeams())
  const w = await welcome(app)
  await w.getByTestId('team').first().getByRole('button', { name: /목록에서 지우기/ }).click()
  await w.getByTestId('remove-confirm').getByRole('button', { name: '지우기' }).click()
}

test('a clear with no list that never settles (a busy Mac): the next person\'s AI browser call works at once and finds nothing of the first person; removing the team finishes', async () => {
  test.setTimeout(150_000)
  const userData = newUserData()
  const app = await launch(userData, {}, SECURE_SHOP)
  const log = appLog(app)
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(() => fetch('/test/login?user=raka'))
    await page.evaluate(() => (window as any).mycelDesktop.pane.open())
    await stickClears(app, 'no-list')

    // raka: a site keeps a sign-in in every place it can
    await openOnce(app, '/store.html')
    await expect.poll(async () => text(await run(ACME, 'get_page_text')), { timeout: 15_000 }).toContain('stored')
    const before = await storedOnShop(app)
    expect(before).toContain('cookie=[kept=1]')
    expect(before).toContain('ls=[1]')
    expect(before).toContain('idb=[kept]')
    expect(before).toContain('caches=[kept]')
    expect(before).toContain('sw=[1]')

    // raka signs out: the AI's call is refused (nobody signed in), at once
    await page.evaluate(() => fetch('/test/logout'))
    newTurn()
    const t0 = Date.now()
    const refused = await run(ACME, 'get_page_text')
    expect(refused.result.ok).toBe(false)
    expect(Date.now() - t0).toBeLessThan(8_000)

    // seungju signs in on the same desk: the AI's next call works at once, and nothing of raka's is left
    await page.evaluate(() => fetch('/test/login?user=seungju'))
    const t1 = Date.now()
    const after = await storedOnShop(app)
    expect(Date.now() - t1).toBeLessThan(30_000)
    expect(after).toContain('cookie=[]')
    expect(after).toContain('ls=[]')
    expect(after).toContain('idb=[]')
    expect(after).toContain('caches=[]')
    expect(after).toContain('sw=[0]')
    // the explicit list settled: nothing waited for the time limit
    expect(unfinished(log)).toEqual([])

    // removing the team finishes: off the list at once, its files gone once both partitions are cleared (the list)
    const id = teams(userData)[0].id
    const t2 = Date.now()
    await removeOnlyTeam(app, page)
    await expect.poll(() => teams(userData).length, { timeout: 8_000 }).toBe(0)
    await expect.poll(() => existsSync(join(userData, 'teams', id)), { timeout: 8_000 }).toBe(false)
    expect(Date.now() - t2).toBeLessThan(8_000)
    expect(unfinished(log)).toEqual([])
  } finally {
    await close(app)
  }
})

test('every clear stuck: the time limit lets the AI browser call through after a person switch, and removing the team still finishes', async () => {
  test.setTimeout(150_000)
  const userData = newUserData()
  const app = await launch(userData)
  const log = appLog(app)
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(() => fetch('/test/login?user=raka'))
    await page.evaluate(() => (window as any).mycelDesktop.pane.open())
    await openOnce(app, '/set-cookie')
    await stickClears(app, 'all')

    // another person signs in: the clear never finishes, the call goes on after the time limit (10 s)
    await page.evaluate(() => fetch('/test/logout'))
    await page.evaluate(() => fetch('/test/login?user=seungju'))
    newTurn()
    const t0 = Date.now()
    const { callId } = await call(ACME, 'navigate', { url: `${SHOP}/cookie` })
    // the site is not allowed for seungju: asked again (the switch happened even though the clear did not finish)
    await expect((await chrome(app)).getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, callId)).result.ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(40_000)
    await expect.poll(() => unfinished(log).join('\n')).toContain('in-app browser')
    expect(unfinished(log)[0]).toContain('storage timeout, cache timeout, logins timeout')
    // later calls do not wait again
    const t1 = Date.now()
    expect((await run(ACME, 'get_page_text')).result.ok).toBe(true)
    expect(Date.now() - t1).toBeLessThan(8_000)

    // removing the team: off the list at once; both partitions time out side by side, then its files go
    const id = teams(userData)[0].id
    const t2 = Date.now()
    await removeOnlyTeam(app, page)
    await expect.poll(() => teams(userData).length, { timeout: 8_000 }).toBe(0)
    await expect.poll(() => existsSync(join(userData, 'teams', id)), { timeout: 30_000 }).toBe(false)
    expect(Date.now() - t2).toBeLessThan(30_000)
    await expect.poll(() => unfinished(log).filter((l) => l.includes(`team ${id} `)).length).toBe(2)
    // the team list is usable again
    await expect((await view(app, (u) => u.endsWith('/welcome.html'))).getByRole('textbox', { name: '초대 링크 또는 팀 주소' })).toBeVisible()
  } finally {
    await close(app)
  }
})
