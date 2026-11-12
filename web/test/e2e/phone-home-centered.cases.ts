// Home on a phone, laid out like an AI app (QA TC-391). The owner, on the iPhone home (11-12): "메인 화면이 이게 맞아?";
// the greeting and the box sat low under a big empty area, with a separate "기본 AI ⌄" line under the box. He wants the
// mark and the greeting in the middle and one composer card (the text on top, + · the engine picker · mic · send in a
// row under it), with one hard rule: "항상 키패드가 올라와있던데? 우리는 그러면 안되잖아 채팅이 보고싶은 걸 수도
// 있는데" — the keyboard never comes up by itself, so the tab bar stays until the person taps the box.
// The row's steps, at 390×844 and 360×780 (touch):
// 1–2. Open the app (트리나 tab) and look without touching: the mark and the greeting in the middle third of the free
//      space; the card above the tab bar holds + · the engine picker (two or more engines; TC-182: none with one) · mic
//      · send, each taking taps from 44 px; no "기본 AI" line outside the card; nothing focused; the tab bar shows.
// 3.   Tap the box: it has the focus; the keyboard up (the iPhone app's WebView and Android shrink the window, iOS
//      Safari only visualViewport: lib/viewport.ts), the card sits right on it and the tab bar goes; the keyboard put
//      away, the tab bar is back.
// 4.   Switch tabs and come back: nothing focused (nor after signing in, nor Back from a chat).
// TC-252 with the card: the keyboard up and a long draft, the whole card stays within 35 % of what is in sight.
// Every Home state (the owner's first time, the goal card, a member's first time, an invited member's welcome, a member
// who chatted, an empty team) fits without overlap; SHOTS_DIR=<folder> saves each one.
// Each test runs in Chromium (Android's engine: phone-home-centered.spec.ts) and WebKit (the iPhone app's:
// phone-home-centered.webkit.spec.ts).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
export const SIZES = [{ width: 390, height: 844 }, { width: 360, height: 780 }] as const

async function call(page: Page, method: 'POST' | 'PATCH', url: string, data: unknown = {}) {
  const r = await page.request.fetch(url, { method, headers: H, data })
  expect(r.ok(), `${method} ${url}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

const box = async (l: Locator) => (await l.boundingBox())!

/** the page settles: fonts, the suggestions that load, a late effect that would focus the box */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
}

/** the message box does not have the focus (so no keyboard came up by itself) */
async function notFocused(page: Page) {
  await settle(page)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)).not.toBe('composer-input')
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
}

/** taps reach the control across a 44 px cross through its middle (a touch-hit box around a smaller control counts; a
 * neighbour drawn over it does not), as phone-targets.spec.ts measures */
async function takes44(l: Locator, what: string) {
  const hits = await l.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    const on = (x: number, y: number) => { const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e)) }
    return [[0, 0], [-21.5, 0], [21.5, 0], [0, -21.5], [0, 21.5]].map(([dx, dy]) => on(cx + dx, cy + dy))
  })
  expect(hits, what).toEqual([true, true, true, true, true])
}

/** the free space the mark and the greeting share: between the one thing at the top (or the column's top) and the
 * suggestions (or, with none, the card) */
async function freeArea(page: Page) {
  return page.evaluate(() => {
    const r = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
    const top = r('home-top'), tail = r('home-tail'), dock = r('home-dock')
    return { above: top.bottom, below: tail.height > 0 ? tail.top : dock.top }
  })
}

/** the mark and the greeting in the middle third of the free space, the mark over the greeting */
async function greetingCentred(page: Page) {
  const { above, below } = await freeArea(page)
  const g = await box(page.getByRole('heading', { level: 1 }))
  const third = (below - above) / 3
  const middle = g.y + g.height / 2
  expect(middle, `greeting middle ${middle} in ${above}..${below}`).toBeGreaterThanOrEqual(above + third)
  expect(middle, `greeting middle ${middle} in ${above}..${below}`).toBeLessThanOrEqual(below - third)
  const mark = page.getByTestId('home-mark')
  await expect(mark).toBeVisible()
  const m = await box(mark)
  expect(m.y + m.height).toBeLessThanOrEqual(g.y)
  expect(Math.abs(m.x + m.width / 2 - (g.x + g.width / 2))).toBeLessThanOrEqual(2)
}

/** the card right above the tab bar, the tab bar in sight */
async function cardOnTabs(page: Page) {
  const tabs = page.getByTestId('bottom-tabs')
  await expect(tabs).toBeVisible()
  const dock = await box(page.getByTestId('home-dock')), bar = await box(tabs)
  expect(Math.abs(dock.y + dock.height - bar.y)).toBeLessThanOrEqual(1)
  const card = await box(page.getByTestId('composer'))
  expect(card.y + card.height).toBeLessThanOrEqual(bar.y)
}

/** one card: the text on top, a row under it with + · (the engine picker) · mic · send, each taking taps from 44 px; no
 * row under the card, and no "기본 AI" line outside it */
async function oneCard(page: Page, engines: boolean) {
  const card = page.getByTestId('composer')
  const input = card.getByTestId('composer-input')
  const tools = card.getByTestId('composer-tools')
  await expect(tools).toBeVisible()
  const controls = [['attach-button', '+'], ...(engines ? [['engine-picker', 'engine']] : []), ['voice-button', 'mic'], ['send', 'send']] as const
  const text = await box(input)
  let left = -1
  for (const [id, what] of controls) {
    const c = tools.getByTestId(id)
    await expect(c, what).toBeVisible()
    const b = await box(c)
    // under the text, in one row, in this order
    expect(b.y, what).toBeGreaterThanOrEqual(text.y + text.height - 1)
    expect(b.x, what).toBeGreaterThan(left)
    left = b.x
    await takes44(c, what)
  }
  await expect(tools.getByTestId('engine-picker')).toHaveCount(engines ? 1 : 0)
  if (engines) {
    await expect(tools.getByTestId('engine-picker')).toContainText(t['composer.defaultEngine'])
    // its name says what it does and what is chosen
    await expect(tools.getByTestId('engine-picker')).toHaveAccessibleName(t['composer.engineNow'].replace('{engine}', t['composer.defaultEngine']))
  }
  // the text starts where the + does
  const textLeft = await input.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
  expect(Math.abs(textLeft - (await box(tools.getByTestId('attach-button'))).x)).toBeLessThanOrEqual(1)
  // nothing under the card: the old row is gone, and the only "기본 AI" on the page is the card's
  await expect(page.getByTestId('composer-controls')).toHaveCount(0)
  await expect(page.getByTestId('home-scroll').getByText(t['composer.defaultEngine'], { exact: true })).toHaveCount(engines ? 1 : 0)
  // the text spans the card (not squeezed beside the buttons)
  const c = await box(card)
  expect(text.width).toBeGreaterThanOrEqual(c.width - 40)
}

type Kind = 'app' | 'safari'

/** The keyboard comes up as `kind` says (phone-keyboard.spec.ts): the iPhone app's WebView and Android shrink the
 * window; iOS Safari keeps it and shrinks only visualViewport. `top`: what is left above it. */
async function openKeyboard(page: Page, kind: Kind, width: number, top: number) {
  if (kind === 'safari') {
    await page.evaluate((h) => {
      const vv = window.visualViewport!
      Object.defineProperty(vv, 'height', { get: () => h, configurable: true })
      vv.dispatchEvent(new Event('resize'))
    }, top)
  } else await page.setViewportSize({ width, height: top })
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h'))).toBe(`${top}px`)
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('keyboard-open'))).toBe(true)
}
async function closeKeyboard(page: Page, kind: Kind, size: { width: number; height: number }) {
  if (kind === 'safari') {
    await page.evaluate(() => {
      Reflect.deleteProperty(window.visualViewport!, 'height')
      window.visualViewport!.dispatchEvent(new Event('resize'))
    })
  } else await page.setViewportSize(size)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h'))).toBe(`${size.height}px`)
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('keyboard-open'))).toBe(false)
}

/** the card sits on the keyboard: at most 8 px between its bottom and what is in sight's */
async function cardOnKeyboard(page: Page) {
  const c = await box(page.getByTestId('composer'))
  const bottom = await page.evaluate(() => window.visualViewport!.height + window.visualViewport!.offsetTop)
  expect(c.y + c.height).toBeLessThanOrEqual(bottom)
  expect(bottom - (c.y + c.height)).toBeLessThanOrEqual(8)
  // and the text and send in sight
  const input = await box(page.getByTestId('composer-input'))
  expect(input.y).toBeGreaterThanOrEqual(0)
  await expect(page.getByTestId('bottom-tabs')).toBeHidden()
}

/** As the owner: the team's start with bob in its group and the four kept skills; signed out after. */
async function teamWithSkills(page: Page) {
  await signIn(page)
  const team = await call(page, 'POST', '/api/onboarding/welcome/team')
  await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
  await call(page, 'PATCH', `/api/admin/groups/${team.progress.teamGroup.id}`, { memberIds: ['olga', 'bob'] })
  await call(page, 'POST', '/api/onboarding/packs/general/install', { skills: ['intro-deck', 'card-news', 'promo-video'] })
  await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
  await page.context().clearCookies()
}

const goal = () => {
  const start = Date.now() - 86_400_000
  return { goal: { state: 'open', target: 3, days: 7, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * 86_400_000).toISOString(), daysLeft: 6, skill: null, reachedAt: null, joined: 1, waiting: { first: '민지', more: 0 } } }
}

/** Each Home state the row names, set up from a reset server and opened on the 트리나 tab; `ready`: what shows once it
 * is there. */
const STATES: { name: string; open: (page: Page) => Promise<void>; ready: (page: Page) => Locator }[] = [
  {
    // the owner who started the team and left the welcome steps: their row at the top
    name: 'owner-first',
    open: async (page) => {
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      // opening the app lands on the unfinished steps (once); ‹ leads to Home, which keeps their row at the top
      await page.goto('/')
      await page.getByTestId('welcome-bar-back').click()
      await expect(page).toHaveURL(/\/$/)
    },
    ready: (page) => page.getByTestId('welcome-resume'),
  },
  {
    name: 'owner-goal',
    open: async (page) => {
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      await call(page, 'POST', '/api/onboarding/packs/work/install', { skills: ['humanizer'] })
      await call(page, 'POST', '/__test/team-goal', goal())
      await page.goto('/')
    },
    ready: (page) => page.getByTestId('team-goal'),
  },
  {
    name: 'member-first',
    open: async (page) => {
      await teamWithSkills(page)
      await signIn(page, BOB)
      await page.getByTestId('tab-ai').click()
    },
    ready: (page) => page.getByTestId('team-prepared'),
  },
  {
    name: 'member-welcome',
    open: async (page) => {
      await page.request.post('/__test/member-welcome', { data: { welcome: {
        team: 'Acme', inviter: { id: 'olga', name: 'Olga' }, people: 3, rooms: [{ id: '01900000-0000-7000-8000-0000000000a1', kind: 'all', name: null }],
        owner: { id: 'olga', name: 'Olga' }, steps: { rooms: true, hi: false, photo: false, asked: false }, allSet: false,
      } } })
      await signIn(page, BOB)
      await page.getByTestId('tab-ai').click()
    },
    ready: (page) => page.getByTestId('member-welcome'),
  },
  {
    name: 'member-chatted',
    open: async (page) => {
      await page.request.post('/__test/often-asked', { data: { team: ['회의록을 요약해 줘', '주간 보고서 초안 써 줘', '고객 메일 답장 써 줘', '발표 자료 목차 만들어 줘'] } })
      await teamWithSkills(page)
      await signIn(page, BOB)
      for (const title of ['a', 'b', 'c', 'd', 'e']) await call(page, 'POST', '/api/chats', { title })
      await page.goto('/')
    },
    ready: (page) => page.getByTestId('often-asked').or(page.getByTestId('team-prepared')),
  },
  {
    // no AI answers a member yet: the no-AI card at the top, the team's suggestions read-only
    name: 'member-no-ai',
    open: async (page) => {
      await teamWithSkills(page)
      await page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: false, action: 'ask_owner', requested: false } }))
      await signIn(page, BOB)
      await page.getByTestId('tab-ai').click()
    },
    ready: (page) => page.getByTestId('home-top').locator(':scope > *').first(),
  },
  {
    // the owner's team with no skills and no files yet: 스킬 넣기 · 팀 파일 넣기
    name: 'empty-team',
    open: async (page) => {
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      await page.goto('/')
    },
    ready: (page) => page.getByTestId('team-prepared-add'),
  },
]

/** nothing on Home overlaps: the one thing at the top, the mark, the greeting, the suggestions and the card, in that
 * order down the page (measured scrolled to the end, where the docked card is in its own place: a page taller than the
 * screen scrolls under it); no page wider than the phone. Returns whether the page scrolls. */
async function noOverlap(page: Page) {
  const boxes = await page.evaluate(() => {
    const q = (sel: string) => document.querySelector<HTMLElement>(sel)
    const scroll = q('[data-testid="home-scroll"]')!
    scroll.scrollTop = scroll.scrollHeight
    const at = (el: HTMLElement | null, name: string) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      // where it is in the scrolled page, so a long page scrolled to its top still counts
      return r.height > 0 ? { name, top: r.top + scroll.scrollTop, bottom: r.bottom + scroll.scrollTop } : null
    }
    return {
      list: [at(q('[data-testid="home-top"]'), 'top'), at(q('[data-testid="home-mark"]'), 'mark'), at(q('h1'), 'greeting'), at(q('[data-testid="home-tail"]'), 'suggestions'), at(q('[data-testid="home-dock"]'), 'card')].filter((x) => !!x),
      wide: document.documentElement.scrollWidth > innerWidth || scroll.scrollWidth > scroll.clientWidth,
      scrolls: scroll.scrollHeight > scroll.clientHeight + 1,
    }
  })
  expect(boxes.wide).toBe(false)
  for (let i = 1; i < boxes.list.length; i++) {
    const a = boxes.list[i - 1]!, b = boxes.list[i]!
    expect(a.bottom, `${a.name} above ${b.name}`).toBeLessThanOrEqual(b.top + 1)
  }
  return boxes.scrolls
}

export function homeCenteredCases() {
  for (const size of SIZES) {
    test.describe(`${size.width}×${size.height}`, () => {
      test.use({ viewport: size, hasTouch: true, isMobile: true, serviceWorkers: 'block' })

      test('TC-391 steps 1–4: the greeting in the middle, one card above the tab bar, the keyboard only on a tap', async ({ page }) => {
        await page.emulateMedia({ colorScheme: 'light' })
        await reset(page)
        await signIn(page)
        // 1. Open the app on the 트리나 tab
        await page.goto('/')
        await expect(page.getByTestId('composer-input')).toBeVisible()
        await expect(page.getByTestId('engine-picker')).toBeVisible()
        // 2. Look without touching: nothing focused, the tab bar there, the greeting in the middle, one card
        await notFocused(page)
        await cardOnTabs(page)
        await greetingCentred(page)
        await oneCard(page, true)
        await shot(page, `steps-${size.width}-1-open.png`)

        // 3. Tap the box: the focus (the keyboard), the card right on it; the keyboard put away: the tab bar is back
        const input = page.getByTestId('composer-input')
        for (const kind of ['app', 'safari'] as const) {
          await input.tap()
          await expect(input).toBeFocused()
          await openKeyboard(page, kind, size.width, Math.round(size.height / 2))
          await cardOnKeyboard(page)
          // the mark makes room for the suggestions while the keyboard is up
          await expect(page.getByTestId('home-mark')).toBeHidden()
          if (kind === 'app') await shot(page, `steps-${size.width}-3-keyboard.png`)
          // put away (iOS's Done or a swipe down): the field lets go of the focus
          await input.evaluate((el) => el.blur())
          await closeKeyboard(page, kind, size)
          await cardOnTabs(page)
          await notFocused(page)
        }

        // 4. Switch tabs and come back (대화: a tab whatever the other tabs are; after a focus too, twice): the box is not
        // focused by itself
        for (let round = 0; round < 2; round++) {
          await page.getByTestId('tab-chats').click()
          await expect(page.getByTestId('composer-input')).toHaveCount(0)
          await page.getByTestId('tab-ai').click()
          await expect(page).toHaveURL(/\/$/)
          await expect(page.getByTestId('composer-input')).toBeVisible()
          await notFocused(page)
          await cardOnTabs(page)
        }
        await greetingCentred(page)
      })

      test('TC-252 with the card: the keyboard up and a long draft, the whole card at most 35 % of what is in sight', async ({ page }) => {
        await reset(page)
        await signIn(page)
        const input = page.getByTestId('composer-input')
        await input.tap()
        await input.fill(Array.from({ length: 20 }, (_, i) => `${i + 1}. 오늘 정한 일을 한 줄씩 적어요`).join('\n'))
        for (const [kind, top] of [['app', 480], ['app', Math.round(size.height / 2)], ['safari', Math.round(size.height / 2)]] as const) {
          await openKeyboard(page, kind, size.width, top)
          const card = await box(page.getByTestId('composer'))
          expect(card.height, `${kind} ${top}: the card ${card.height} px`).toBeLessThanOrEqual(top * 0.35 + 2)
          // the text and send in sight, the card on the keyboard
          const field = await box(input), send = await box(page.getByTestId('send'))
          expect(field.y).toBeGreaterThanOrEqual(0)
          expect(send.y + send.height).toBeLessThanOrEqual(top)
          await cardOnKeyboard(page)
          if (kind === 'app' && top === 480) await shot(page, `keyboard-long-draft-${size.width}x480.png`)
          await closeKeyboard(page, kind, size)
        }
        // the keyboard down: the text may grow again (to 240 px at most)
        expect((await box(input)).height).toBeLessThanOrEqual(241)
      })

      test('sign-in and Back from a chat: the box is not focused by itself', async ({ page }) => {
        await reset(page)
        await signIn(page)
        await expect(page).toHaveURL(/\/$/)
        await notFocused(page)
        await page.getByTestId('composer-input').fill('안녕하세요')
        await page.getByTestId('send').click()
        await expect(page).toHaveURL(/\/c\//)
        await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
        await page.getByTestId('chat-back').click()
        await expect(page).toHaveURL(/\/$/)
        await expect(page.getByTestId('composer-input')).toBeVisible()
        await notFocused(page)
        await cardOnTabs(page)
      })

      test('TC-182 with the card: one engine on, no picker in it; + · mic · send stay', async ({ page }) => {
        await reset(page)
        await signIn(page)
        await call(page, 'PATCH', '/api/admin/engines', { enabled: { codex: false } })
        await page.goto('/')
        await expect(page.getByTestId('composer-tools')).toBeVisible()
        await oneCard(page, false)
        await cardOnTabs(page)
      })

      test('every Home state fits without overlap, the card above the tab bar', async ({ page }) => {
        test.setTimeout(120_000)
        await page.emulateMedia({ colorScheme: 'light' })
        for (const state of STATES) {
          await test.step(state.name, async () => {
            await reset(page)
            await state.open(page)
            await expect(state.ready(page)).toBeVisible()
            await notFocused(page)
            // the AI's mark over the greeting, except under the welcome card that fills the top
            if (state.name === 'member-welcome') await expect(page.getByTestId('home-mark')).toHaveCount(0)
            else await expect(page.getByTestId('home-mark').locator('[data-trina-star]')).toBeVisible()
            const scrolls = await noOverlap(page)
            // only the invited person's welcome card (its steps' rows) is taller than the screen
            if (state.name !== 'member-welcome') expect(scrolls, `${state.name} fits the screen`).toBe(false)
            await page.unrouteAll({ behavior: 'ignoreErrors' })
            await expect(page.getByTestId('home-scroll').getByText(t['composer.defaultEngine'], { exact: true })).toHaveCount(await page.getByTestId('engine-picker').count())
            await expect(page.getByTestId('composer-controls')).toHaveCount(0)
            await page.getByTestId('home-scroll').evaluate((el) => { el.scrollTop = 0 })
            await shot(page, `${size.width}-${state.name}.png`)
            // the card stays docked right above the tab bar, scrolled or not
            await cardOnTabs(page)
          })
        }
      })
    })
  }
}
