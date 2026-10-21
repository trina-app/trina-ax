// Desktop app end to end: the real Electron app (dist/), real browser pane over CDP, fake team servers that speak
// the shared WebSocket contract (browser.call -> browser.ack / browser.result), and a fixture website.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import {
  ACME, activityLog, addTeam, answer, BAD, bindWindow, BETA, call, cancel, chrome, close, LAN, launch, newTurn, newUserData, OFFICE_SITE, result, run, SHOP, siteHits, skew, tabPage, teamPage, text, view, welcome,
} from './helpers'

const refOf = (s: string, label: string) => {
  const line = s.split('\n').find((l) => l.includes(label))
  const m = line && /\[(ref_\d+)\]/.exec(line)
  if (!m) throw new Error(`no ref for "${label}" in:\n${s}`)
  return m[1]
}
const teamsJson = (userData: string) => JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8')) as { teams: { id: string; origin: string; label: string }[] }

/** A new turn opens a shop page; the person allows the site for this turn. */
async function openShop(app: ElectronApplication, path = '/') {
  newTurn()
  const { callId } = await call(ACME, 'navigate', { url: `${SHOP}${path}` })
  await answer(app, '이번만 허용', 'site')
  const r = await result(ACME, callId)
  expect(r.result.ok, text(r)).toBe(true)
  // the person's answer travels with the result (the server keeps it in tool_events)
  expect(text(r)).toContain('The user allowed shop.test:19153 for this turn.')
  return tabPage(app, (u) => u.startsWith(SHOP))
}

test.describe('team address and window', () => {
  test('addresses are checked, the team is remembered, the bridge exists only in the top frame', async () => {
    const userData = newUserData()
    let app = await launch(userData)
    try {
      const w = await welcome(app)
      const box = w.getByRole('textbox', { name: '팀 주소' })
      await box.fill('http://example.com')
      await w.getByRole('button', { name: '연결' }).click()
      await expect(w.getByTestId('address-error')).toHaveText('보안 연결(https) 주소만 쓸 수 있어요.')
      await box.fill('localhost:19159')
      await w.getByRole('button', { name: '연결' }).click()
      await expect(w.getByTestId('address-error')).toHaveText('팀 서버에 연결할 수 없어요. 주소와 인터넷 연결을 확인하세요.')

      const page = await addTeam(app, 'acme.localhost:19151', ACME)
      await expect(page.locator('#bridge')).toHaveText('desktop')
      // artifact-like sandboxed frame: no bridge, no WebRTC; the top frame keeps both
      await expect.poll(() => page.evaluate(() => (window as any).__frame)).toEqual({ rtc: 'undefined', bridge: 'undefined' })
      expect(await page.evaluate(() => typeof RTCPeerConnection)).toBe('function')
      // nor can it get WebRTC back from a fresh child frame (same-origin about:blank or srcdoc)
      const nested = (await expect.poll(() => page.evaluate(() => (window as any).__nested)).toBeTruthy(), await page.evaluate(() => (window as any).__nested))
      expect(nested.srcdoc).toBe('undefined')
      expect(nested.media).toBe('undefined')
      expect(String(nested.child)).not.toBe('function')
      expect(nested.childCanMake).not.toBe('made')
      // a frame trying to navigate away is stopped
      await page.waitForTimeout(500)
      expect(await siteHits('/frame-escape')).toBe(0)
      // links to other sites open in the person's browser, the window stays on the team
      await app.evaluate(({ shell }) => {
        ;(globalThis as any).__opened = []
        shell.openExternal = async (u: string) => void (globalThis as any).__opened.push(u)
      })
      await page.evaluate(() => document.getElementById('external')!.click())
      await expect.poll(() => app.evaluate(() => (globalThis as any).__opened)).toEqual(['https://example.com/outside'])
      expect(page.url().startsWith(ACME)).toBe(true)
      // signed in: the team name from /api/me replaces the address label
      await page.evaluate(() => fetch('/test/login'))
      await page.reload()
      await expect.poll(() => teamsJson(userData).teams[0].label).toBe('Acme Team')
    } finally {
      await close(app)
    }
    // next start opens the last team directly
    app = await launch(userData)
    try {
      const page = await teamPage(app, ACME)
      await expect(page.locator('#team')).toHaveText('Acme')
      expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getTitle())).toBe('Acme Team — Team AX')
    } finally {
      await close(app)
    }
  })
  test('an unreachable team server shows the offline screen with retry and the team list', async () => {
    const userData = newUserData()
    let app = await launch(userData)
    try {
      await addTeam(app, 'acme.localhost:19151', ACME)
    } finally {
      await close(app)
    }
    // the server moved away (simulated by pointing the remembered team at a closed port)
    const f = teamsJson(userData)
    f.teams[0].origin = 'http://gone.localhost:19159'
    writeFileSync(join(userData, 'teams.json'), JSON.stringify(f))
    app = await launch(userData)
    try {
      const w = await welcome(app)
      await expect(w.getByTestId('offline')).toContainText('팀 서버에 연결할 수 없어요')
      await expect(w.getByTestId('offline')).toContainText('http://gone.localhost:19159')
      await w.getByRole('button', { name: '다시 시도' }).click()
      await expect(w.getByTestId('offline')).toBeVisible()
      await w.getByRole('button', { name: '다른 팀' }).click()
      await expect(w.getByTestId('team')).toHaveCount(1)
      await addTeam(app, 'beta.localhost:19152', BETA)
    } finally {
      await close(app)
    }
  })
})

test.describe('browser tools over the team WebSocket', () => {
  let app: ElectronApplication
  test.beforeAll(async () => {
    app = await launch(newUserData())
    await addTeam(app, 'acme.localhost:19151', ACME)
  })
  test.afterAll(async () => close(app))

  test('the person allows the site once, then the AI reads, clicks, types and fills forms', async () => {
    const tab = await openShop(app)
    const c = await chrome(app)
    await expect(c.getByTestId('pane-tab')).toHaveText([/Proto Shop/])
    await expect(c.getByTestId('pane-address')).toHaveValue(`${SHOP}/`)

    const tree = text(await run(ACME, 'read_page', { filter: 'interactive' }))
    expect(tree).toContain('searchbox "상품 검색"')
    const found = text(await run(ACME, 'find', { query: '장바구니' }))
    const add = refOf(found, '장바구니 담기')
    const click = await run(ACME, 'computer', { action: 'left_click', ref: add })
    expect(text(click)).toContain('left click')
    await expect.poll(() => tab.evaluate(() => document.getElementById('cart')!.textContent)).toBe('장바구니 1개')

    const q = refOf(tree, '상품 검색')
    await run(ACME, 'computer', { action: 'left_click', ref: q })
    await run(ACME, 'computer', { action: 'type', text: '노트북' })
    await run(ACME, 'computer', { action: 'key', text: 'cmd+a Backspace' })
    await run(ACME, 'computer', { action: 'type', text: '태블릿' })
    expect(await tab.evaluate(() => (document.getElementById('q') as HTMLInputElement).value)).toBe('태블릿')

    const formTree = text(await run(ACME, 'read_page', { filter: 'interactive' }))
    expect((await run(ACME, 'form_input', { ref: refOf(formTree, 'textbox "이름"'), value: '홍길동' })).result.ok).toBe(true)
    expect((await run(ACME, 'form_input', { ref: refOf(formTree, 'checkbox'), value: true })).result.ok).toBe(true)
    expect((await run(ACME, 'form_input', { ref: refOf(formTree, 'combobox'), value: '빠른 배송' })).result.ok).toBe(true)
    expect(await tab.evaluate(() => [(document.getElementById('name') as HTMLInputElement).value, (document.getElementById('agree') as HTMLInputElement).checked, (document.getElementById('ship') as HTMLSelectElement).value])).toEqual(['홍길동', true, 'fast'])

    expect(text(await run(ACME, 'get_page_text'))).toContain('Proto Shop')
  })

  test('password fields refuse clicks, typing and form_input, and the person sees it', async () => {
    const tab = await tabPage(app, (u) => u.startsWith(SHOP))
    const tree = text(await run(ACME, 'read_page', { filter: 'interactive' }))
    const pw = refOf(tree, '비밀번호')
    const otp = refOf(tree, 'OTP')
    for (const r of [await run(ACME, 'form_input', { ref: pw, value: 'hunter2' }), await run(ACME, 'form_input', { ref: otp, value: '123456' }), await run(ACME, 'computer', { action: 'left_click', ref: pw })]) {
      expect(r.result.ok).toBe(false)
      expect(text(r)).toContain('password field')
    }
    // focused by the page (or the person): typing is refused, Tab still works
    await tab.evaluate(() => document.getElementById('pw')!.focus())
    const typed = await run(ACME, 'computer', { action: 'type', text: 'hunter2' })
    expect(typed.result.ok).toBe(false)
    expect((await run(ACME, 'computer', { action: 'key', text: 'Tab' })).result.ok).toBe(true)
    expect(await tab.evaluate(() => (document.getElementById('pw') as HTMLInputElement).value)).toBe('')
    const c = await chrome(app)
    // needs the person now: the one line over the page (and the log)
    await expect(c.getByTestId('notice')).toHaveAttribute('data-kind', 'password')
    await expect((await activityLog(app)).locator('[data-kind="password"]').first()).toBeVisible()
  })

  test('console, network bodies, scripts (always shown), screenshots, viewport emulation', async () => {
    const tab = await tabPage(app, (u) => u.startsWith(SHOP))
    expect(text(await run(ACME, 'read_console_messages', { onlyErrors: true }))).toContain('[error] payment widget failed')
    const list = text(await run(ACME, 'read_network_requests', { urlPattern: 'data.json' }))
    const id = /\[([^\]]+)\] GET http:\/\/shop\.test:19153\/data\.json/.exec(list)?.[1]
    expect(id).toBeTruthy()
    expect(text(await run(ACME, 'read_network_requests', { requestId: id }))).toContain('{"items":[1,2,3]}')
    expect(text(await run(ACME, 'javascript_tool', { action: 'javascript_exec', text: 'await Promise.resolve(6 * 7)' }))).toBe('42')
    // logged every time (the activity log), not shown over the page
    const log = await activityLog(app)
    await expect(log.locator('[data-kind="script"]').first()).toContainText('shop.test:19153')
    await expect(log.locator('[data-kind="network"]').first()).toBeVisible()

    const shot = await run(ACME, 'computer', { action: 'screenshot', save_to_disk: true })
    const img = shot.result.content.find((x) => x.type === 'image') as { mime: string; data: string; shareToChat?: boolean }
    expect(img.mime).toBe('image/jpeg')
    expect(img.shareToChat).toBe(true)
    expect(Buffer.from(img.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')

    expect(text(await run(ACME, 'resize_window', { preset: 'mobile' }))).toContain('viewport 375x812')
    expect(await tab.evaluate(() => [screen.width, navigator.maxTouchPoints])).toEqual([375, 5])
    await run(ACME, 'resize_window', { preset: 'desktop' })
    expect(await tab.evaluate(() => screen.width)).toBeGreaterThan(375)
  })

  test('tabs and batches', async () => {
    const created = text(await run(ACME, 'tabs_create', {}))
    const newId = /Created tab (tab-\d+)/.exec(created)![1]
    const ctx = JSON.parse(text(await run(ACME, 'tabs_context')).split('\nThe browser pane')[0])
    expect(ctx.tabs).toHaveLength(2)
    expect(text(await run(ACME, 'tabs_close', { tabId: newId }))).toContain(`Closed tab ${newId}`)
    const batch = await run(ACME, 'browser_batch', { actions: [{ name: 'find', input: { query: '이름' } }, { name: 'computer', input: { action: 'screenshot' } }] })
    expect(batch.result.ok).toBe(true)
    expect(text(batch)).toContain('[2/2] computer')
    const bad = await run(ACME, 'browser_batch', { actions: [{ name: 'computer', input: { action: 'nope' } }, { name: 'find', input: { query: 'x' } }] })
    expect(bad.result.ok).toBe(false)
    expect(text(bad)).toContain('Stopped at action 1')
    const flood = await run(ACME, 'computer', { action: 'key', text: 'Escape', repeat: 100 })
    expect(flood.result.ok, text(flood)).toBe(true)
    const tooMany = await run(ACME, 'computer', { action: 'key', text: Array(11).fill('Escape').join(' '), repeat: 100 })
    expect(text(tooMany)).toContain('At most 1000 key presses')
    const invalid = await run(ACME, 'computer', { action: 'left_click', coordinate: 'here' })
    expect(text(invalid)).toContain('Invalid input for computer')
  })

  test('a replayed call is not run twice; stop, cancel and deadlines end calls', async () => {
    const tab = await tabPage(app, (u) => u.startsWith(SHOP))
    const cart = () => tab.evaluate(() => Number(/\d+/.exec(document.getElementById('cart')!.textContent!)![0]))
    const before = await cart()
    const add = refOf(text(await run(ACME, 'find', { query: '장바구니 담기' })), '장바구니 담기')
    const { callId } = await call(ACME, 'computer', { action: 'left_click', ref: add }, { callId: 'dup-click-1' })
    await result(ACME, callId)
    await call(ACME, 'computer', { action: 'left_click', ref: add }, { callId: 'dup-click-1' })
    await expect.poll(async () => (await result(ACME, callId)).count).toBe(2)
    expect(await cart()).toBe(before + 1)

    // "AI is using" while a call runs; the person's stop button ends it
    const c = await chrome(app)
    const waiting = await call(ACME, 'computer', { action: 'wait', duration: 10 })
    await expect(c.getByTestId('driving')).toBeVisible()
    await expect(c.locator('body')).toHaveClass(/driving/)
    const t0 = Date.now()
    await c.getByTestId('stop').click()
    const stopped = await result(ACME, waiting.callId)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(text(stopped)).toContain('The user stopped')
    await expect(c.getByTestId('driving')).toBeHidden()

    const w2 = await call(ACME, 'computer', { action: 'wait', duration: 10 })
    await new Promise((r) => setTimeout(r, 300))
    await cancel(ACME, w2.callId)
    expect(text(await result(ACME, w2.callId))).toContain('The turn was stopped.')

    const late = await run(ACME, 'tabs_context', {}, { deadlineMs: -1000 })
    expect(text(late)).toContain('after its deadline')
  })

  test('deadlines are read on the server clock: a computer whose clock runs ahead still runs calls', async () => {
    // the team server's clock is 10 minutes behind this computer
    await skew(ACME, -600_000)
    try {
      const page = await teamPage(app, ACME)
      await page.reload()
      await bindWindow(page, ACME)
      await page.waitForTimeout(500) // the window measures the offset after the page loaded
      const r = await run(ACME, 'tabs_context', {}, { deadlineMs: 30_000 })
      expect(r.result.ok, text(r)).toBe(true)
      expect(text(await run(ACME, 'tabs_context', {}, { deadlineMs: -1000 }))).toContain('after its deadline')
    } finally {
      await skew(ACME, 0)
      await (await teamPage(app, ACME)).reload()
      await bindWindow(await teamPage(app, ACME), ACME)
    }
  })
})

test.describe('what the in-app browser never opens', () => {
  let app: ElectronApplication
  test.beforeAll(async () => {
    app = await launch(newUserData())
    await addTeam(app, 'acme.localhost:19151', ACME)
  })
  test.afterAll(async () => close(app))

  test('the team address, this computer and data: pages are refused without asking', async () => {
    newTurn()
    const c = await chrome(app)
    for (const [url, says] of [
      [`${ACME}/api/me`, "team's own address"],
      ['http://localhost:19153/', 'this computer'],
      ['http://127.0.0.1:19153/', 'this computer'],
      ['http://[::1]:19153/', 'this computer'],
      ['http://0.0.0.0:19153/', 'this computer'],
      ['data:text/html,<iframe src="http://shop.test:19153/cookie"></iframe>', 'Only http(s)'],
      ['file:///etc/passwd', 'Only http(s)'],
    ] as const) {
      const r = await run(ACME, 'navigate', { url })
      expect(r.result.ok, url).toBe(false)
      expect(text(r), url).toContain(says)
      await expect(c.getByTestId('permission-prompt')).toHaveCount(0)
    }
    const p = await run(ACME, 'preview_start', { url: `${ACME}/` })
    expect(text(p)).toContain("team's own address")
  })

  test('pages cannot reach the team address or this computer, not even by redirect; the person cannot type them either', async () => {
    const probe = await openShop(app, '/fetch-team')
    await expect.poll(() => probe.evaluate(() => document.getElementById('out')!.textContent)).toBe('blocked,blocked,blocked')
    const c = await chrome(app)
    // a page's own requests: logged, nothing over the page
    await expect((await activityLog(app)).locator('[data-kind="forbidden"]').first()).toBeVisible()
    await expect(c.getByTestId('notice')).toHaveCount(0)

    // redirect from an allowed site to the team address: stopped, the tab never shows the team page
    const r = await run(ACME, 'navigate', { url: `${SHOP}/redirect-team` })
    expect(r.result.ok).toBe(false)
    expect(text(r)).toContain('was blocked')
    expect(app.windows().filter((w) => w.url().startsWith(ACME))).toHaveLength(1) // only the team page itself

    // the person types the team address into the pane: refused, shown in the toolbar
    await c.getByTestId('pane-address').fill(`${ACME}/`)
    await c.getByTestId('pane-address').press('Enter')
    await expect(c.getByTestId('notice')).toHaveAttribute('data-kind', 'forbidden')
    await expect(c.getByTestId('notice')).toContainText('acme.localhost:19151')
    await new Promise((r) => setTimeout(r, 500))
    expect(app.windows().filter((w) => w.url().startsWith(ACME))).toHaveLength(1)
  })

  test('a page that lies about its viewport size cannot make screenshots huge', async () => {
    await openShop(app, '/huge-viewport')
    const shot = await run(ACME, 'computer', { action: 'screenshot' })
    expect(shot.result.ok, text(shot)).toBe(true)
    expect(text(shot)).not.toContain('50000000')
    const zoom = await run(ACME, 'computer', { action: 'zoom', region: [0, 0, 1e9, 1e9] })
    expect(zoom.result.ok, text(zoom)).toBe(true)
    const img = zoom.result.content.find((x) => x.type === 'image') as { data: string }
    expect(img.data.length).toBeLessThan(5_000_000)
  })

  test('the in-app browser carries its User-Agent mark and looks like plain Chrome otherwise', async () => {
    const r = await run(ACME, 'navigate', { url: `${SHOP}/ua` })
    expect(r.result.ok, text(r)).toBe(true)
    const ua = await (await tabPage(app, (u) => u === `${SHOP}/ua`)).locator('#ua').textContent()
    expect(ua).toContain('MycelBrowser/1')
    expect(ua).not.toContain('Electron')
    expect(ua).not.toMatch(/Team AX|mycel\//i)
  })
})

test.describe('office network and allowed sites', () => {
  test('private addresses need approval, sub-requests are blocked, redirects ask again, typed addresses do not', async () => {
    const app = await launch(newUserData())
    try {
      await addTeam(app, 'acme.localhost:19151', ACME)
      newTurn()
      const denied = await call(ACME, 'navigate', { url: `${OFFICE_SITE}/` })
      await answer(app, '거부', 'private')
      const d = await result(ACME, denied.callId)
      expect(d.result.ok).toBe(false)
      expect(text(d)).toContain('declined opening the office-network address nas.lan:19153')

      const intranet = await openShop(app, '/intranet.html')
      await expect.poll(() => intranet.evaluate(() => document.getElementById('out')!.textContent)).toBe('blocked')
      const c = await chrome(app)
      await expect((await activityLog(app)).locator('[data-kind="blocked"]').first()).toContainText('nas.lan:19153')
      await expect(c.getByTestId('notice')).toHaveCount(0)

      // a public page redirecting into the office: asked during the same call
      newTurn()
      const redirect = await call(ACME, 'navigate', { url: `${SHOP}/redirect-private` })
      await answer(app, '이번만 허용', 'site')
      await answer(app, '이번만 허용', 'private')
      const r = await result(ACME, redirect.callId)
      expect(r.result.ok, text(r)).toBe(true)
      expect(text(r)).toContain(`${OFFICE_SITE}/index.html`)

      // the person types an office address in the pane: no prompt
      await c.getByTestId('pane-address').fill(`${OFFICE_SITE}/cookie`)
      await c.getByTestId('pane-address').press('Enter')
      await tabPage(app, (u) => u === `${OFFICE_SITE}/cookie`)
      await expect(c.getByTestId('permission-prompt')).toHaveCount(0)
    } finally {
      await close(app)
    }
  })

  test('"always" is saved per team and can be removed; teams do not share browser data; removing a team', async () => {
    const userData = newUserData()
    let app = await launch(userData)
    try {
      await addTeam(app, 'acme.localhost:19151', ACME)
      const first = await call(ACME, 'navigate', { url: `${SHOP}/set-cookie` })
      await answer(app, '항상 허용', 'site')
      expect((await result(ACME, first.callId)).result.ok).toBe(true)
    } finally {
      await close(app)
    }
    app = await launch(userData)
    try {
      await bindWindow(await teamPage(app, ACME), ACME)
      // remembered: no prompt this time; the pane's own cookie is still there
      newTurn()
      const again = await run(ACME, 'navigate', { url: `${SHOP}/cookie` })
      expect(again.result.ok, text(again)).toBe(true)
      const acmeTab = await tabPage(app, (u) => u === `${SHOP}/cookie`)
      expect(await acmeTab.locator('#c').textContent()).toContain('fixture=1')

      const c = await chrome(app)
      await c.getByTestId('sites-button').click()
      await expect(c.getByTestId('sites')).toContainText('shop.test:19153')
      await c.getByTestId('sites').getByRole('button', { name: '삭제' }).click()
      await expect(c.getByTestId('sites')).toContainText('항상 허용한 사이트가 없어요.')
      // "clear all" (shown with two or more saved sites)
      for (const host of ['shop.test:19153', 'nas.lan:19153']) {
        newTurn()
        const g = await call(ACME, 'navigate', { url: `http://${host}/` })
        await answer(app, '항상 허용')
        expect((await result(ACME, g.callId)).result.ok).toBe(true)
      }
      await c.getByTestId('sites-button').click()
      await c.getByTestId('sites-button').click()
      await expect(c.getByTestId('sites').locator('li')).toHaveCount(2)
      await c.getByTestId('sites-clear').click()
      await expect(c.getByTestId('sites')).toContainText('항상 허용한 사이트가 없어요.')
      await c.getByTestId('sites-button').click()
      newTurn()
      const asks = await call(ACME, 'navigate', { url: `${SHOP}/` })
      await answer(app, '이번만 허용', 'site')
      expect((await result(ACME, asks.callId)).result.ok).toBe(true)

      // a second team: own partition, its browser has no cookie from the first team
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].focus())
      await (await view(app, (u) => u.startsWith(ACME))).evaluate(() => (window as any).mycelDesktop.openTeams())
      await addTeam(app, 'beta.localhost:19152', BETA)
      newTurn()
      const b = await call(BETA, 'navigate', { url: `${SHOP}/cookie` })
      await answer(app, '이번만 허용', 'site')
      expect((await result(BETA, b.callId)).result.ok).toBe(true)
      await expect.poll(() => acmeTab.isClosed()).toBe(true)
      const betaTab = await tabPage(app, (u) => u === `${SHOP}/cookie`)
      await expect(betaTab.locator('#c')).not.toContainText('fixture=1')

      // remove the first team: gone from the list and its data folder
      await (await view(app, (u) => u.startsWith(BETA))).evaluate(() => (window as any).mycelDesktop.openTeams())
      const w = await welcome(app)
      const acmeRow = w.getByTestId('team').filter({ hasText: 'acme' })
      await acmeRow.getByRole('button', { name: /목록에서 지우기/ }).click()
      await w.getByTestId('remove-confirm').getByRole('button', { name: '지우기' }).click()
      await expect(w.getByTestId('team')).toHaveCount(1)
      expect(teamsJson(userData).teams.map((x) => x.origin)).toEqual([BETA])
    } finally {
      await close(app)
    }
  })
})

test.describe('office direct connection', () => {
  test('the pinned LAN address is used when it answers; the sign-in cookie follows', async () => {
    const userData = newUserData()
    let app = await launch(userData)
    try {
      await welcome(app).then((w) => w.getByRole('textbox', { name: '팀 주소' }).fill('lan.localhost:19156'))
      await (await welcome(app)).getByRole('button', { name: '연결' }).click()
      const direct = await view(app, (u) => u.startsWith('https://127.0.0.1:19154'), 30_000)
      await expect.poll(() => direct.evaluate(() => (window as any).testState?.connection?.route)).toBe('direct')
      await expect.poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getTitle())).toContain('사무실 직접 연결')
      // put a session cookie on the team address only
      const id = teamsJson(userData).teams[0].id
      await app.evaluate(async ({ session }, id) => {
        const s = session.fromPartition(`persist:team-${id}`)
        await s.cookies.remove('https://127.0.0.1:19154', '__Host-sid')
        await s.cookies.set({ url: 'http://lan.localhost:19156', name: 'mycel-dev-sid', value: 'from-relay', httpOnly: true, path: '/', expirationDate: Date.now() / 1000 + 3600 })
      }, id)
    } finally {
      await close(app)
    }
    app = await launch(userData)
    try {
      const direct = await view(app, (u) => u.startsWith('https://127.0.0.1:19154'), 30_000)
      await expect.poll(() => direct.evaluate(() => fetch('/test/whoami').then((r) => r.json()))).toEqual({ session: 'from-relay', secure: true })
    } finally {
      await close(app)
    }
  })

  test('when the office address stops answering, the window moves to the team address instead of going offline', async () => {
    const userData = newUserData()
    const app = await launch(userData)
    try {
      const w = await welcome(app)
      await w.getByRole('textbox', { name: '팀 주소' }).fill('lan.localhost:19156')
      await w.getByRole('button', { name: '연결' }).click()
      const direct = await view(app, (u) => u.startsWith('https://127.0.0.1:19154'), 30_000)
      await expect.poll(() => direct.evaluate(() => (window as any).testState?.connection?.route)).toBe('direct')
      await fetch('http://127.0.0.1:19156/test/lan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ up: false }) })
      // the page navigates (reload, a link) while the office address is gone
      await app.evaluate(({ webContents }) => {
        const wc = webContents.getAllWebContents().find((x) => x.getURL().startsWith('https://127.0.0.1:19154'))
        wc?.reload()
      })
      const remote = await view(app, (u) => u.startsWith(LAN), 20_000)
      await bindWindow(remote, LAN)
      await expect.poll(() => remote.evaluate(() => (window as any).testState?.connection?.route)).toBe('remote')
      await expect((await welcome(app)).getByTestId('offline')).toHaveCount(0)
    } finally {
      await fetch('http://127.0.0.1:19156/test/lan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ up: true }) })
      await close(app)
    }
  })

  test('a LAN certificate that does not match the pin is refused and the team address is used', async () => {
    const app = await launch(newUserData())
    try {
      const page = await addTeam(app, 'bad.localhost:19157', BAD)
      await expect.poll(() => page.evaluate(() => (window as any).testState?.connection?.fingerprintMismatch), { timeout: 20_000 }).toBe(true)
      expect(page.url().startsWith(BAD)).toBe(true)
      expect(await page.evaluate(() => (window as any).testState.connection.route)).toBe('remote')
      // and the team server hears about it through the team address (Diagnostics: office direct connection failed)
      await expect.poll(async () => ((await (await fetch(`${BAD}/test/lan-failures`)).json()) as { items: { code: string; csrf: boolean }[] }).items, { timeout: 10_000 }).toContainEqual({ code: 'cert_mismatch', csrf: true })
    } finally {
      await close(app)
    }
  })
})
