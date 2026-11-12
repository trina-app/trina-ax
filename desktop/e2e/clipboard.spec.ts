// The answer's "Copy" (web/src/lib/clipboard.ts) inside the desktop app: the team page may put formatted text on the
// clipboard (text/html beside text/plain) through the async clipboard (the session allows clipboard-sanitized-write
// for the team origin, src/main/security.ts) and through the copy command (its fallback on a plain-http team server).
// A picture goes the same way as a PNG (the image viewer's 복사). It writes the computer's real clipboard: what was on it
// is put back afterwards.
import { expect, test } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData } from './helpers'

const HTML = '<table><tr><th>name</th></tr><tr><td><strong>alpha</strong></td></tr></table>'
const PLAIN = '| name |\n|---|\n| **alpha** |'

test('the team page puts both text/html and text/plain, and a PNG, on the clipboard', async () => {
  const app = await launch(newUserData())
  // Electron's clipboard API in the main process is the web's (read / write ClipboardItems)
  const saved = await app.evaluate(async ({ clipboard }) => {
    const out: Record<string, string> = {}
    try {
      for (const item of await clipboard.read()) for (const type of item.types) {
        if (/^(text\/(plain|html|rtf)|image\/png)$/.test(type) && !(type in out)) out[type] = Buffer.from(await (await item.getType(type) as Blob).arrayBuffer()).toString('base64')
      }
    } catch {}
    return out
  })
  const read = () => app.evaluate(async ({ clipboard }) => {
    const out: Record<string, string> = {}
    for (const item of await clipboard.read()) for (const type of item.types) if (type === 'text/html' || type === 'text/plain') out[type] = await (await item.getType(type) as Blob).text()
    return out
  })
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(({ html, plain }) => {
      const w = window as unknown as Record<string, unknown>
      const add = (id: string, run: () => unknown) => {
        const b = document.createElement('button')
        b.id = id
        b.textContent = id
        b.onclick = () => { w[id] = Promise.resolve().then(run).then((v) => (v === false ? 'refused' : 'ok'), (e) => String(e)) }
        document.body.append(b)
      }
      // the async clipboard: one item with both flavours
      add('async', () => navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]))
      // the copy command whose event carries both
      add('command', () => {
        const onCopy = (e: ClipboardEvent) => { e.clipboardData!.setData('text/html', html); e.clipboardData!.setData('text/plain', plain); e.preventDefault() }
        const ta = document.createElement('textarea')
        ta.value = plain
        document.body.append(ta)
        ta.select()
        document.addEventListener('copy', onCopy, true)
        try { return document.execCommand('copy') } finally { document.removeEventListener('copy', onCopy, true); ta.remove() }
      })
    }, { html: HTML, plain: PLAIN })
    for (const id of ['async', 'command']) {
      await app.evaluate(({ clipboard }) => clipboard.clear())
      await page.click(`#${id}`)
      await expect.poll(() => page.evaluate((k) => (window as unknown as Record<string, unknown>)[k], id)).toBe('ok')
      const got = await read()
      expect(Object.keys(got).sort(), id).toEqual(['text/html', 'text/plain'])
      expect(got['text/html'], id).toContain('<table>')
      expect(got['text/html'], id).toContain('<strong>alpha</strong>')
      expect(got['text/plain'], id).toBe(PLAIN)
    }
    // a picture (the image viewer's 복사, web/src/lib/copyImage.ts): a PNG drawn on the page, written through the async
    // clipboard with its bytes still being made; its transparent half stays transparent
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      const b = document.createElement('button')
      b.id = 'image'
      b.textContent = 'image'
      b.onclick = () => {
        const c = document.createElement('canvas')
        c.width = 40
        c.height = 20
        const g = c.getContext('2d')!
        g.fillStyle = 'rgb(220, 20, 30)'
        g.fillRect(20, 0, 20, 20)
        const png = new Promise<Blob>((resolve) => c.toBlob((x) => resolve(x!), 'image/png'))
        w.image = navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(() => 'ok', (e) => String(e))
      }
      document.body.append(b)
    })
    await page.click('#image')
    await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).image)).toBe('ok')
    const image = await app.evaluate(async ({ clipboard, nativeImage }) => {
      for (const item of await clipboard.read()) {
        if (!item.types.includes('image/png')) continue
        const i = nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png') as Blob).arrayBuffer()))
        const { width, height } = i.getSize()
        const bmp = i.toBitmap()
        const alpha = (x: number, y: number) => bmp[(y * width + x) * 4 + 3]
        return { width, height, left: alpha(5, 10), right: alpha(30, 10) }
      }
      return null
    })
    expect(image).toEqual({ width: 40, height: 20, left: 0, right: 255 })
  } finally {
    await app.evaluate(async ({ clipboard, ClipboardItem }, s) => {
      clipboard.clear()
      const types = Object.keys(s)
      if (types.length) await clipboard.write([new ClipboardItem(Object.fromEntries(types.map((t) => [t, new Blob([Buffer.from(s[t]!, 'base64')], { type: t })])))])
    }, saved).catch(() => {})
    await close(app)
  }
})
