// Phones: every control takes taps from at least 44 × 44 px (Apple's minimum; Material's is 48 dp), and text fields
// show 16 px text, so iOS Safari does not zoom in when one gets the focus (docs/DECISIONS.md "Phones: 44 px targets
// and 16 px fields"). Measured at 390×844 twice: as a touch phone, and as a narrow window with a mouse (so it holds by
// width alone, and the controls a phone hides behind a long press are measured too): what a tap
// really reaches, from the control's middle outwards (document.elementFromPoint), so a hit box drawn around a small
// control (touch-hit) counts and a neighbour drawn over it does not. It measures a cross through the middle (across
// and down), not every point of the box. A field counts with its <label> frame, a switch with its label, and a message
// box's text area (one line in a taller box) only by its text size. A control covered at its middle fails, unless a
// scrolling row it sits in has scrolled it out of sight. On the screens people use most on a phone.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come from page.route, which a service worker would go around
test.use({ viewport: { width: 390, height: 844 }, locale: 'en-US', serviceWorkers: 'block' })

type Control = { what: string; w: number; h: number; font: number | null; covered?: true }

/** The controls on screen (not under the phone's tab bar) whose tap area is under 44 px, and the fields under 16 px. */
async function tooSmall(page: Page): Promise<{ small: Control[]; fields: Control[] }> {
  // the page settles (fonts, a list that loads, a late notice)
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  return page.evaluate(() => {
    const bottom = document.querySelector('[data-testid="tab-ai"]')?.getBoundingClientRect().top ?? innerHeight
    const sel = 'button, a[href], [role=tab], [role=menuitem], input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), select, textarea, label:has(input[type=checkbox])'
    const small: Control[] = []
    const fields: Control[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.top < 0 || r.bottom > bottom || r.left < 0 || r.right > innerWidth) continue
      if (el.closest('[inert], [aria-hidden="true"], .sr-only-focusable')) continue
      // drawn see-through (a row's ⋯ that shows on hover with a mouse), or not taking taps at all
      let seen = true
      for (let p: HTMLElement | null = el; p && seen; p = p.parentElement) if (getComputedStyle(p).opacity === '0') seen = false
      const own = getComputedStyle(el)
      if (!seen || own.pointerEvents === 'none' || own.visibility !== 'visible') continue
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const field = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
      // a tap on a field's <label> frame (a search box's icon and padding) goes to the field
      const target = (field && el.closest('label')) || el
      const on = (x: number, y: number) => {
        const e = document.elementFromPoint(x, y)
        return !!e && (e === target || target.contains(e))
      }
      const what = `${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`
      if (!on(cx, cy)) {
        // scrolled out of a scrolling row (a tab past the end of the tabs): out of sight, not covered
        let clipped = false
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p)
          const b = p.getBoundingClientRect()
          if ((cs.overflowX !== 'visible' || cs.overflowY !== 'visible') && (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom)) clipped = true
        }
        if (!clipped) small.push({ what, w: 0, h: 0, font: null, covered: true })
        continue
      }
      const reach = (dx: number, dy: number) => {
        let n = 0
        while (n < 30 && on(cx + dx * (n + 1), cy + dy * (n + 1))) n++
        return n
      }
      const c: Control = {
        what,
        w: reach(-1, 0) + reach(1, 0) + 1,
        h: reach(0, -1) + reach(0, 1) + 1,
        font: field ? parseFloat(getComputedStyle(el).fontSize) : null,
      }
      // a pixel for rounding: the reach is counted in whole pixels from a middle that can sit between two
      if ((c.w < 43 || c.h < 43) && el.tagName !== 'TEXTAREA') small.push(c)
      if (field && c.font! < 16) fields.push(c)
    }
    return { small, fields }
  })
}

async function expectPhoneSized(page: Page) {
  const { small, fields } = await tooSmall(page)
  expect(small, 'controls with a tap area under 44 px').toEqual([])
  expect(fields, 'fields with text under 16 px').toEqual([])
}

for (const touch of [true, false])
  test.describe(touch ? 'a touch phone' : 'a narrow window with a mouse', () => {
    test.use({ hasTouch: touch, isMobile: touch })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  })

  test('Home: the message box and its buttons', async ({ page }) => {
    await signIn(page)
    await page.goto('/')
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expectPhoneSized(page)
  })

  test('Team skills: the tabs, the search, Change, and each skill\'s ⋯', async ({ page }) => {
    await signIn(page)
    for (const [p, text] of [
      ['skills/weekly.md', '---\nname: weekly\ndescription: Weekly team report\n---\nSum up\n'],
      ['skills/offer.md', '---\nname: offer\ndescription: Write a price offer\n---\nRead it\n'],
    ]) expect((await page.request.post('/__test/file', { data: { path: p, text } })).ok()).toBeTruthy()
    await page.goto('/skills')
    await expect(page.getByTestId('skill-row').first()).toBeVisible()
    await expect(page.getByTestId('skill-editors-change')).toBeVisible()
    await expectPhoneSized(page)
  })

  test('a room: its header buttons and the message box', async ({ page }) => {
    await routeRoom(page, { members: [{ id: 'bob', name: 'Bob' }], messages: [{ id: '019a5f00-0000-7000-8000-000000000101', author: { id: 'bob', name: 'Bob' }, body: 'Can you check the deck?' }] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    await expect(page.getByText('Can you check the deck?')).toBeVisible()
    await expectPhoneSized(page)
  })

  test('Files: the tabs, New folder and Upload, the path, who sees the folder, each file\'s ⋯', async ({ page }) => {
    await signIn(page)
    await page.goto('/files?path=marketing')
    await expect(page.getByTestId('file-menu').first()).toBeVisible()
    await expect(page.getByTestId('folder-access-chip')).toBeVisible()
    await expectPhoneSized(page)
  })

  test('sign-in and join: the fields, the buttons and the links under them', async ({ page, browser }) => {
    await page.goto('/login')
    await expect(page.getByTestId('login-username')).toBeVisible()
    await expectPhoneSized(page)

    await signIn(page)
    const r = await page.request.post('/api/admin/team-link', { headers: { [CSRF_HEADER]: '1' }, data: {} })
    expect(r.status()).toBe(201)
    const link = new URL((await r.json()).link.url)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', hasTouch: touch, isMobile: touch })
    const p = await ctx.newPage()
    await p.goto(link.pathname + link.hash)
    await expect(p.getByTestId('join-signin')).toBeVisible()
    await expectPhoneSized(p)
    await ctx.close()
  })

  test('Settings: the list, Profile\'s form and Notifications\' switches', async ({ page }) => {
    await signIn(page)
    await page.goto('/settings')
    await expect(page.getByTestId('settings-row-notifications')).toBeVisible()
    await expectPhoneSized(page)
    await page.goto('/settings/profile')
    await expect(page.getByRole('textbox').first()).toBeVisible()
    await expectPhoneSized(page)
    await page.goto('/settings/notifications')
    await expect(page.getByRole('checkbox').first()).toBeAttached()
    await expectPhoneSized(page)
  })
  })

for (const width of [768, 1440])
  test(`a computer or tablet keeps its sizes at ${width} px: 36 px buttons and 14 px fields`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/login')
    expect((await page.getByTestId('login-submit').boundingBox())!.height).toBe(36)
    expect(await page.getByTestId('login-username').evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px')
  })
