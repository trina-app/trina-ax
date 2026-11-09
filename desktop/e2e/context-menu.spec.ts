// The right-click menu (src/main/context-menu.ts, docs/DECISIONS.md "Desktop: a right-click menu"). On the team page: a
// photo inside a button (a room message's thumbnail) and a picture the page drew from its own bytes (the preview panel's
// original, a blob: address) get 이미지 복사 / 이미지 저장…, a picture from elsewhere only 이미지 복사, a link 링크 복사,
// selected text 복사, a text field the four edit items, empty space nothing; a picture inside a frame of the page (an
// artifact) nothing. The first-run screen's text field gets the edit items. The native menu is not shown: the test
// takes the menu where it would pop up and runs an item's click as the menu would. Nothing reaches the computer's
// clipboard (the copy and edit calls are caught) and the save is caught at will-download and cancelled.
import { expect, test } from '@playwright/test'
import { ACME, addTeam, close, launch, newUserData, welcome } from './helpers'

interface Caught {
  menus: { label: string; enabled: boolean }[][]
  copiedAt: [number, number][]
  /** the page's edit commands run (cut, copy, paste, selectAll) */
  edits: string[]
  links: string[]
  saved: { url: string; mime: string }[]
}

test('a right-click gets the items that apply: photo, link, text, a text field; copying and saving run in the app', async () => {
  const app = await launch(newUserData())
  try {
    await app.evaluate(({ Menu, clipboard }) => {
      const g = globalThis as unknown as { __ctx: Caught; __menu?: Electron.Menu }
      g.__ctx = { menus: [], copiedAt: [], edits: [], links: [], saved: [] }
      Menu.prototype.popup = function (this: Electron.Menu) {
        g.__menu = this
        g.__ctx.menus.push(this.items.map((i) => ({ label: i.type === 'separator' ? '|' : i.label, enabled: i.enabled })))
      }
      clipboard.writeText = async (text: string) => void g.__ctx.links.push(text)
    })
    const caught = () => app.evaluate(() => (globalThis as unknown as { __ctx: Caught }).__ctx)
    const menus = async (n: number) => {
      await expect.poll(async () => (await caught()).menus.length).toBe(n)
      return (await caught()).menus[n - 1]!
    }
    const labels = (m: { label: string }[]) => m.map((i) => i.label)
    // the first-run screen's box for the invite link: the edit items
    const first = await welcome(app)
    await first.getByRole('textbox', { name: '초대 링크 또는 팀 주소' }).click({ button: 'right' })
    expect(labels(await menus(1))).toEqual(['잘라내기', '복사', '붙여넣기', '|', '모두 선택'])

    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await app.evaluate(({ webContents }, origin) => {
      const g = globalThis as unknown as { __ctx: Caught }
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))!
      wc.copyImageAt = (x: number, y: number) => void g.__ctx.copiedAt.push([x, y])
      for (const k of ['cut', 'copy', 'paste', 'selectAll'] as const) wc[k] = () => void g.__ctx.edits.push(k)
      wc.session.on('will-download', (e, item) => {
        g.__ctx.saved.push({ url: item.getURL(), mime: item.getMimeType() })
        e.preventDefault()
      })
    }, ACME)
    const clickItem = (label: string) => app.evaluate((_e, l) => {
      const item = (globalThis as unknown as { __menu: Electron.Menu }).__menu.items.find((i) => i.label === l)!
      item.click()
    }, label)
    // a photo in a button (a message's thumbnail), the preview panel's blob: original, a picture from elsewhere, a link,
    // text and a text field
    const blobUrl = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 40
      c.height = 30
      const g = c.getContext('2d')!
      g.fillStyle = '#e33'
      g.fillRect(0, 0, 40, 30)
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))
      const url = URL.createObjectURL(blob)
      document.body.insertAdjacentHTML('beforeend', `<div id="ctx" style="position:fixed;inset:0;background:#fff;z-index:99;padding:20px;display:flex;flex-direction:column;gap:16px;align-items:flex-start">
        <button id="tile" type="button" style="padding:0;border:1px solid #ccc"><img id="thumb" src="${url}" alt="" style="display:block;width:120px;height:90px"></button>
        <img id="original" src="${url}" alt="acme-logo.png" style="width:120px;height:90px">
        <img id="elsewhere" src="${c.toDataURL()}" alt="" style="width:120px;height:90px">
        <a id="link" href="https://example.org/acme-plan">acme plan</a>
        <p id="text">acme quarterly numbers</p>
        <textarea id="box">draft</textarea>
        <div id="empty" style="width:200px;height:40px"></div>
        <iframe id="ctx-art" sandbox="allow-scripts" style="width:300px;height:110px;border:1px solid #ccc"></iframe>
      </div>`)
      // an artifact's frame (opaque origin) with a picture it drew and one pointing at a team address
      ;(document.getElementById('ctx-art') as HTMLIFrameElement).srcdoc = `<body style="margin:0;display:flex;gap:8px"><img id="drawn" src="${c.toDataURL()}" style="width:120px;height:90px"><img id="team" src="${location.origin}/api/files/download?path=users%2Facme%2Fpay.png" style="width:120px;height:90px"><a id="art-link" href="https://example.org/acme-art">art</a></body>`
      await Promise.all([...document.querySelectorAll<HTMLImageElement>('#ctx img')].map((i) => i.decode()))
      return url
    })

    // the thumbnail inside its button
    await page.click('#thumb', { button: 'right' })
    expect(labels(await menus(2))).toEqual(['이미지 복사', '이미지 저장…'])
    await clickItem('이미지 복사')
    const box = (await page.locator('#thumb').boundingBox())!
    const [[x, y]] = (await caught()).copiedAt
    // where the right-click was, in the page's own coordinates
    expect(x).toBeGreaterThanOrEqual(box.x)
    expect(x).toBeLessThanOrEqual(box.x + box.width)
    expect(y).toBeGreaterThanOrEqual(box.y)
    expect(y).toBeLessThanOrEqual(box.y + box.height)
    // the preview panel's original: saved from the page's own bytes, with the app's save (caught and cancelled here)
    await page.click('#original', { button: 'right' })
    expect(labels(await menus(3))).toEqual(['이미지 복사', '이미지 저장…'])
    await clickItem('이미지 저장…')
    await expect.poll(async () => (await caught()).saved).toEqual([{ url: blobUrl, mime: 'image/png' }])
    // a picture from elsewhere: copied, not saved
    await page.click('#elsewhere', { button: 'right' })
    expect(labels(await menus(4))).toEqual(['이미지 복사'])
    // a link: its address on the clipboard, nothing opened
    await page.click('#link', { button: 'right' })
    // (on a Mac a right-click also selects the word under it, which adds 복사, as in any Mac app)
    expect(labels(await menus(5)).filter((l) => l !== '|' && l !== '복사')).toEqual(['링크 복사'])
    expect(labels(await menus(5))[0]).toBe('링크 복사')
    await clickItem('링크 복사')
    expect((await caught()).links).toEqual(['https://example.org/acme-plan'])
    // selected text: 복사, run on this page
    await page.locator('#text').selectText()
    await page.click('#text', { button: 'right' })
    expect(await menus(6)).toEqual([{ label: '복사', enabled: true }])
    await clickItem('복사')
    expect((await caught()).edits).toEqual(['copy'])
    // a text field: the four edit items (nothing selected yet: cut and copy greyed out)
    await page.evaluate(() => {
      const b = document.getElementById('box') as HTMLTextAreaElement
      b.focus()
      b.setSelectionRange(b.value.length, b.value.length)
    })
    await page.click('#box', { button: 'right' })
    const field = await menus(7)
    expect(labels(field)).toEqual(['잘라내기', '복사', '붙여넣기', '|', '모두 선택'])
    // (붙여넣기 follows what is on the computer's clipboard)
    expect([field[0]!.enabled, field[1]!.enabled, field[4]!.enabled]).toEqual([false, false, true])
    await clickItem('모두 선택')
    expect((await caught()).edits).toEqual(['copy', 'selectAll'])
    // empty space: no menu
    await page.click('#empty', { button: 'right' })
    // a picture inside the artifact's frame: no photo items, so no menu (copying or saving is for the page itself)
    const art = page.frameLocator('#ctx-art')
    await expect(art.locator('#drawn')).toBeVisible()
    await art.locator('#drawn').click({ button: 'right' })
    await art.locator('#team').click({ button: 'right' })
    await page.waitForTimeout(500)
    expect((await caught()).menus).toHaveLength(7)
    // (the frame's right-clicks do reach the menu: its link gets 링크 복사)
    await art.locator('#art-link').click({ button: 'right' })
    expect(labels(await menus(8))[0]).toBe('링크 복사')
    // the page stayed where it was, the image was copied only once, nothing else saved
    expect(page.url().startsWith(ACME)).toBe(true)
    expect((await caught()).copiedAt).toHaveLength(1)
    expect((await caught()).saved).toHaveLength(1)
  } finally {
    await close(app)
  }
})
