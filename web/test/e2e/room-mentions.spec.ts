// Mentions in a room's message box, in the browser (components/rooms/useMentionMenu.tsx, components/TokenTextarea.tsx):
// a name picked from the "@" list stands out at once in the accent colour of a sent mention, acts as one piece (the
// caret steps over it, Backspace takes all of it), a pasted "@name" stays text, "@트리나" stands out where it calls the
// AI, a Korean IME writes next to a token without the caret jumping, the layer under the box keeps its lines where the
// box has them (phone width, a long text that scrolls), and what is sent mentions exactly the people whose names stand
// out. The room is answered through page.route (rooms-mock.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block' })

const MJ = { id: 'minjae', name: 'Minjaelee' }
const SORA = { id: 'sora', name: '소라님' }
const LONG = { id: 'bart', name: 'Bartholomew Konstantinopoulos-Vanderbilt' }
const SEEN = { id: '019a5f00-0000-7000-8000-000000000001', author: SORA, body: '@Minjaelee 시안 봤어요', mentions: [MJ.id] }

async function openRoom(page: Page) {
  await reset(page)
  const room = await routeRoom(page, { members: [MJ, SORA, LONG], messages: [SEEN] })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-input')).toBeVisible()
  return room
}

async function pick(page: Page, query: string) {
  await page.keyboard.type('@' + query)
  await expect(page.getByTestId('mention-menu')).toBeVisible()
  await page.keyboard.press('Enter')
}

const caret = (page: Page) => page.getByTestId('room-input').first().evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd])
const tokens = (page: Page) => page.getByTestId('room-composer').first().getByTestId('token-layer').locator('[data-token]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-token')}:${e.textContent}`))

test('a picked name stands out at once, acts as one piece, and is exactly what is sent', async ({ page, browserName }) => {
  const room = await openRoom(page)
  const box = page.getByTestId('room-input')
  await box.click()
  await pick(page, 'Minj')
  await expect(box).toHaveValue('@Minjaelee ')
  expect(await tokens(page)).toEqual(['person:@Minjaelee'])
  // the colour of a sent mention
  const sentColour = await page.getByTestId('room-message').locator('span.text-accent-text').first().evaluate((e) => getComputedStyle(e).color)
  const token = page.getByTestId('room-composer').getByTestId('token-layer').locator('[data-token="person"]')
  expect(await token.evaluate((e) => getComputedStyle(e).color)).toBe(sentColour)
  // the box's own letters are not drawn; the layer's are, where the box has them
  expect(await box.evaluate((t) => getComputedStyle(t).webkitTextFillColor)).toBe('rgba(0, 0, 0, 0)')

  // the caret steps over it and never stays inside it
  await page.keyboard.press('ArrowLeft')
  expect(await caret(page)).toEqual([10, 10])
  await page.keyboard.press('ArrowLeft')
  expect(await caret(page)).toEqual([0, 0])
  await page.keyboard.press('ArrowRight')
  expect(await caret(page)).toEqual([10, 10])
  const r = (await token.boundingBox())!
  await page.mouse.click(r.x + r.width * 0.3, r.y + r.height / 2)
  expect(await caret(page)).toEqual([0, 0])
  await page.mouse.click(r.x + r.width * 0.7, r.y + r.height / 2)
  expect(await caret(page)).toEqual([10, 10])

  // Backspace at its end takes all of it (and the list does not open on it)
  await box.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(11, 11))
  await page.keyboard.press('Backspace')
  await expect(box).toHaveValue('@Minjaelee')
  await expect(page.getByTestId('mention-menu')).toHaveCount(0)
  await page.keyboard.press('Backspace')
  await expect(box).toHaveValue('')
  expect(await tokens(page)).toEqual([])

  // a pasted "@name" is text; one picked again, "@트리나" typed
  await pick(page, '소라')
  // (WebKit grants these tests no clipboard: there the text comes as typed text in one piece, as an IME's would)
  if (browserName === 'webkit') await page.keyboard.insertText('@Minjaelee 이것도 ')
  else {
    await page.evaluate(() => navigator.clipboard.writeText('@Minjaelee 이것도 '))
    await page.keyboard.press('ControlOrMeta+V')
  }
  await page.keyboard.type('@트리나 회의록 정리해 줘')
  await expect(box).toHaveValue('@소라님 @Minjaelee 이것도 @트리나 회의록 정리해 줘')
  expect(await tokens(page)).toEqual(['person:@소라님', 'ai:@트리나'])
  // a letter of a token replaced through a selection: plain text
  await box.evaluate((t: HTMLTextAreaElement) => t.setSelectionRange(2, 3))
  await page.keyboard.type('X')
  expect(await tokens(page)).toEqual(['ai:@트리나'])
  if (browserName === 'chromium') {
    // (how much one undo takes back is the engine's own: WebKit takes the typing before it too)
    await page.keyboard.press('ControlOrMeta+Z')
    await expect(box).toHaveValue('@소라님 @Minjaelee 이것도 @트리나 회의록 정리해 줘')
    // the undo brings the letters back, not the mention: what stands out is what is sent
    expect(await tokens(page)).toEqual(['ai:@트리나'])
  }
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await pick(page, '소라')
  await page.keyboard.type('확인 부탁해요 ')
  await pick(page, 'Barth')
  await expect(box).toHaveValue(`@소라님 확인 부탁해요 @${LONG.name} `)
  expect(await tokens(page)).toEqual(['person:@소라님', `person:@${LONG.name}`])

  await page.getByTestId('room-send').click()
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: `@소라님 확인 부탁해요 @${LONG.name}`, mentions: [SORA.id, LONG.id] })
  await expect(box).toHaveValue('')
  // on the sent message the same names stand out
  await expect(page.getByTestId('room-message').last().locator('span.text-accent-text')).toHaveText(['@소라님', `@${LONG.name}`])
})

test('a Korean IME writing next to a token: each syllable shows, the caret stays with it, the token stays whole', async ({ page, browserName }) => {
  // (the IME is driven through Chromium's DevTools protocol)
  test.skip(browserName !== 'chromium')
  const room = await openRoom(page)
  const box = page.getByTestId('room-input')
  await box.click()
  await pick(page, 'Minj')
  const events: string[] = []
  await page.exposeFunction('__ime', (t: string) => events.push(t))
  await box.evaluate((t) => ['compositionstart', 'compositionupdate', 'compositionend'].forEach((n) => t.addEventListener(n, () => (window as unknown as { __ime: (s: string) => void }).__ime(n))))
  const cdp = await page.context().newCDPSession(page)
  const layer = page.getByTestId('room-composer').getByTestId('token-layer')
  // 민 (ㅁ → 미 → 민), then 재 (ㅈ → 재), then 님: as a Korean IME sends them
  for (const [steps, done] of [[['ㅁ', '미', '민'], '민'], [['ㅈ', '재'], '재'], [['ㄴ', '니', '님'], '님']] as const) {
    for (const s of steps) {
      await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
      const v = await box.inputValue()
      expect(v.endsWith(s)).toBe(true)
      // the layer shows the syllable being written, and the caret is right after it
      expect((await layer.textContent())!.replace(/​$/, '')).toBe(v)
      expect(await caret(page)).toEqual([v.length, v.length])
      expect(await tokens(page)).toEqual(['person:@Minjaelee'])
    }
    await cdp.send('Input.insertText', { text: done })
  }
  await expect(box).toHaveValue('@Minjaelee 민재님')
  expect(events).toContain('compositionstart')
  expect(events).toContain('compositionend')
  expect(await tokens(page)).toEqual(['person:@Minjaelee'])
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: '@Minjaelee 민재님', mentions: [MJ.id] })
})

test('while an IME writes, the box paints its own letters (so its underline shows) and the box looks the same', async ({ page }) => {
  await openRoom(page)
  const box = page.getByTestId('room-input')
  await box.click()
  await pick(page, 'Minj')
  await page.keyboard.type('민재님 좀 봐 주세요 ')
  await pick(page, '트리')
  const composer = page.getByTestId('room-composer')
  await page.mouse.move(0, 0)
  const before = await composer.screenshot()
  await box.dispatchEvent('compositionstart')
  expect(await box.evaluate((t) => [t.parentElement!.hasAttribute('data-composing'), getComputedStyle(t).webkitTextFillColor !== 'rgba(0, 0, 0, 0)'])).toEqual([true, true])
  const during = await composer.screenshot()
  await box.dispatchEvent('compositionend')
  expect(await box.evaluate((t) => t.parentElement!.hasAttribute('data-composing'))).toBe(false)
  // the same pixels whoever paints the letters (no flicker at each syllable)
  const differ = await page.evaluate(async ([a, b]) => {
    const load = (src: string) => new Promise<HTMLImageElement>((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = src })
    const [x, y] = await Promise.all([load(a!), load(b!)])
    const data = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data }
    const p = data(x), q = data(y)
    let n = 0
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i]! - q[i]!) + Math.abs(p[i + 1]! - q[i + 1]!) + Math.abs(p[i + 2]! - q[i + 2]!) > 60) n++
    return n / (p.length / 4)
  }, [`data:image/png;base64,${before.toString('base64')}`, `data:image/png;base64,${during.toString('base64')}`])
  expect(differ).toBeLessThan(0.002)
})

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test(`the layer keeps its lines where the box has them (${vp.width}px, a long text that scrolls)`, async ({ page }) => {
    await page.setViewportSize(vp)
    await openRoom(page)
    const box = page.getByTestId('room-input')
    await box.click()
    await pick(page, 'Barth')
    await page.keyboard.type('긴 이름 뒤에 한국어 문장이 이어집니다. 줄이 바뀌는 자리까지 같아야 해요. ')
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(`${i + 1}번째 줄 `)
    }
    await pick(page, 'Minj')
    const m = await box.evaluate((t: HTMLTextAreaElement) => {
      const cs = getComputedStyle(t)
      const layers = (['back', 'front'] as const).map((side) => {
        const l = t.parentElement!.querySelector(`[data-token-layer="${side}"] > div`) as HTMLElement
        const ls = getComputedStyle(l)
        const tok = getComputedStyle(l.querySelector('[data-token]')!)
        return { height: l.offsetHeight, shift: l.style.transform, font: [ls.fontSize, ls.lineHeight, ls.paddingLeft], token: [tok.color, tok.backgroundColor] }
      })
      return { box: t.scrollHeight, scrolled: t.scrollTop, font: [cs.fontSize, cs.lineHeight, cs.paddingLeft], layers }
    })
    // the same lines in both layers: the same height; they moved with the box's scroll
    for (const l of m.layers) {
      expect(l.font).toEqual(m.font)
      expect(Math.abs(l.height - m.box)).toBeLessThanOrEqual(1)
      expect(l.shift).toBe(`translate(0px, ${-m.scrolled}px)`)
    }
    expect(m.scrolled).toBeGreaterThan(0)
    // under the box only a token's background, over it only its letters
    const [back, front] = m.layers
    expect(back!.token[0]).toBe('rgba(0, 0, 0, 0)')
    expect(back!.token[1]).not.toBe('rgba(0, 0, 0, 0)')
    expect(front!.token[0]).not.toBe('rgba(0, 0, 0, 0)')
    expect(front!.token[1]).toBe('rgba(0, 0, 0, 0)')
  })
}

test('the letters follow a theme switched while the box has text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openRoom(page)
  const box = page.getByTestId('room-input')
  await box.click()
  await pick(page, 'Minj')
  await page.keyboard.type('안녕')
  const colours = () => box.evaluate((t) => [getComputedStyle(t).color, getComputedStyle(t.parentElement!.querySelector('[data-token-layer="front"] > div')!).color])
  const [light, lightLayer] = await colours()
  expect(lightLayer).toBe(light)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(async () => (await colours())[0]).not.toBe(light)
  const [dark, darkLayer] = await colours()
  expect(darkLayer).toBe(dark)
})

test("a thread's reply box: a picked name stands out and the reply mentions them", async ({ page }) => {
  const room = await openRoom(page)
  await page.goto(`/rooms/${ROOM_ID}/t/${SEEN.id}`)
  const box = page.getByTestId('room-thread').getByTestId('room-input')
  await expect(box).toBeVisible()
  await box.click()
  await pick(page, '소라')
  await page.keyboard.type('네')
  expect(await page.getByTestId('room-thread').getByTestId('token-layer').locator('[data-token]').allTextContents()).toEqual(['@소라님'])
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  expect(room.sent[0]).toMatchObject({ body: '@소라님 네', mentions: [SORA.id], threadRootId: SEEN.id })
})
