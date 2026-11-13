// People's messages in Markdown, in the browser (QA TC-072; components/Markdown.tsx PersonMarkdown, lib/messageMarkdown.ts):
// in a room, a thread reply and a DM, **bold**, *italic*, `code`, lists, code blocks and [links](…) render as an AI
// answer's do; line breaks stay; a mention stands out and a plain address is a link; HTML is text and runs nothing; a
// javascript: link is no link; another site's picture is not loaded; the phone (390) does not widen the page. The room
// is answered through page.route (rooms-mock.ts). SHOTS_DIR=<folder>: screenshots at 1440 and 390 go there.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`
const RICH = '**굵게** *기울임* `code`\n다음 줄 @Olga 확인 https://example.com/a에서\n\n- one\n- two\n\n```\nconst a = 1\n```\n\n[Trina](https://trina.app)'
const XSS = '<b>hi</b> <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>\n[click](javascript:window.__xss=3) ![pixel](https://evil.example/t.png)'

async function open(page: Page, kind?: 'dm') {
  await reset(page)
  await routeRoom(page, {
    kind,
    members: [SORA],
    messages: [
      { id: id(1), author: SORA, body: RICH, mentions: ['olga'] },
      { id: id(2), author: SORA, body: XSS },
      { id: id(3), author: SORA, body: '**스레드** 답글\n- 하나', threadRootId: id(1) },
    ],
  })
  const external: string[] = []
  await page.context().route('https://evil.example/**', (r) => {
    external.push(r.request().url())
    return r.fulfill({ contentType: 'image/png', body: '' })
  })
  await page.context().route('https://example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: 'ok' }))
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss()
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(2)
  return { external, dialogs }
}

test('a room message in Markdown: formatting, line breaks, a mention and a plain link; HTML runs nothing', async ({ page }) => {
  const { external, dialogs } = await open(page)
  const rich = page.getByTestId('room-message').nth(0).getByTestId('message-markdown')
  await expect(rich.locator('strong')).toHaveText('굵게')
  await expect(rich.locator('em')).toHaveText('기울임')
  await expect(rich.locator('p code').first()).toHaveText('code')
  await expect(rich.locator('ul > li')).toHaveText(['one', 'two'])
  await expect(rich.locator('pre')).toContainText('const a = 1')
  await expect(rich.locator('br')).toHaveCount(1)
  // the mention is me: the accent colour on its soft background
  await expect(rich.locator('span.text-accent-text.bg-accent-soft', { hasText: '@Olga' })).toBeVisible()
  const plain = rich.getByTestId('room-link').filter({ hasText: 'example.com' })
  await expect(plain).toHaveAttribute('href', 'https://example.com/a')
  const trina = rich.getByRole('link', { name: 'Trina' })
  await expect(trina).toHaveAttribute('href', 'https://trina.app/')
  await expect(trina).toHaveAttribute('target', '_blank')
  await expect(trina).toHaveAttribute('rel', 'noopener noreferrer nofollow')

  const xss = page.getByTestId('room-message').nth(1).getByTestId('message-markdown')
  await expect(xss).toContainText('<b>hi</b>')
  await expect(xss).toContainText('<script>window.__xss=2</script>')
  await expect(xss.locator('b, img, script')).toHaveCount(0)
  // javascript: is the words "click", no link; the picture is the card that opens it, not loaded
  await expect(xss.getByText('click')).toBeVisible()
  await expect(xss.locator('a[href^="javascript"]')).toHaveCount(0)
  await expect(xss.locator('a[href="https://evil.example/t.png"]')).toBeVisible()
  // a click on the word itself (the words around it are the same paragraph: its middle can be the picture's card,
  // which opens the picture's address in a new tab, as a link does)
  const word = await xss.getByText('click').evaluate((p) => {
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent!.indexOf('click')
      if (at < 0) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + 5)
      const b = r.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    }
    return null
  })
  await page.mouse.click(word!.x, word!.y)
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  expect(dialogs).toEqual([])
  expect(external).toEqual([])
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/room-markdown-1440.png` })
})

test('a thread reply in Markdown; the phone (390) keeps the page its width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  const wide = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(wide).toBeLessThanOrEqual(390)
  await expect(page.getByTestId('room-message').nth(0).locator('strong')).toHaveText('굵게')
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/room-markdown-390.png` })
  await page.goto(`/rooms/${ROOM_ID}/t/${id(1)}`)
  const reply = page.getByTestId('room-message').filter({ hasText: '답글' }).last()
  await expect(reply.locator('strong')).toHaveText('스레드')
  await expect(reply.locator('ul > li')).toHaveText(['하나'])
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/thread-markdown-390.png` })
})

test('a DM in Markdown, the same rules', async ({ page }) => {
  await open(page, 'dm')
  const rich = page.getByTestId('room-message').nth(0).getByTestId('message-markdown')
  await expect(rich.locator('strong')).toHaveText('굵게')
  await expect(page.getByTestId('room-message').nth(1).locator('img, script, b')).toHaveCount(0)
})

// PR #514 review: a message nested thousands deep blanked the whole app ("Maximum call stack size exceeded") for
// everyone who opened the room; one nested 40-60 deep pushed its words off a phone's screen. Links whose words show
// another address than they open show the real one next to them.
const DEEP = ['- '.repeat(1000) + 'x', '>'.repeat(2000) + ' x', '* '.repeat(4000) + 'x', '- '.repeat(2500) + 'x', '>'.repeat(5000) + ' x', '- '.repeat(40) + 'deep list', '> '.repeat(60) + 'deep quote', Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n')]
const SPOOF = ['[paypal.com](https://evil.example/a)', '[paypal.com/login](https://evil.example/x)', '[https:/​/paypal.com](https://evil.example/b)', '[ceo@company.com](mailto:x@evil.example)']

test('messages nested thousands deep do not take the room down; links show where they really go', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  const bodies = ['hello before', ...DEEP, ...SPOOF, 'hello after']
  await routeRoom(page, { members: [SORA], messages: bodies.map((body, i) => ({ id: id(20 + i), author: SORA, body })) })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.context().route('https://evil.example/**', (r) => r.fulfill({ contentType: 'text/html', body: 'evil' }))
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(bodies.length)
  await expect(page.getByText('hello before')).toBeVisible()
  await expect(page.getByText('hello after')).toBeVisible()
  expect(errors).toEqual([])
  // nothing nests deeper than 6 (lib/messageMarkdown.ts MAX_NEST), and the phone's page keeps its width; each message's words stay inside it
  const deepest = await page.evaluate(() => {
    let max = 0
    for (const el of document.querySelectorAll('[data-testid="message-markdown"] blockquote, [data-testid="message-markdown"] ul, [data-testid="message-markdown"] ol')) {
      let d = 0
      for (let e: Element | null = el; e && e.getAttribute('data-testid') !== 'message-markdown'; e = e.parentElement) if (/^(BLOCKQUOTE|UL|OL)$/.test(e.tagName)) d++
      max = Math.max(max, d)
    }
    return max
  })
  expect(deepest).toBeLessThanOrEqual(6)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const msgs = page.getByTestId('room-message')
  for (const [i, words] of [[6, 'deep list'], [7, 'deep quote'], [8, 'level 39']] as const) {
    await expect(msgs.nth(i)).toContainText(words)
    const over = await msgs.nth(i).getByTestId('message-markdown').evaluate((e) => e.scrollWidth - e.clientWidth)
    expect(over).toBeLessThanOrEqual(1)
  }
  // the links: the real host (or address) is on the screen next to the words
  for (const [i, real] of [[9, '(evil.example)'], [10, '(evil.example)'], [12, '(x@evil.example)']] as const) await expect(msgs.nth(i).locator('[data-real-address]')).toHaveText(real)
  await expect(msgs.nth(11).getByRole('link', { name: 'https://evil.example/b' })).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/room-markdown-deep-390.png`, fullPage: true })
})
