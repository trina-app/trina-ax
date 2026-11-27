// file_upload in the real app (docs/decisions/20261126-browser-file-upload.md): the desktop fetches each ticket through
// the team page's session, checks size and sha256, and puts the files into the page: a visible multi-file field, a
// hidden one behind a "파일첨부" button (auto finds the field; how: chooser takes the picker its click opens, with no
// system window), a field inside a label, a drop area; a one-file field refuses many files; a computer click that
// opens a picker is closed with a hint; the site permit comes before any file is fetched; the page uploads the files
// after the call (they stay on disk) and they are gone when the tab closes. The page itself reads back name, size and
// sha256 (crypto.subtle).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { ACME, addTeam, answer, call, chrome, close, launch, newTurn, newUserData, result, run, SHOP, signIn, stopLeftoverApps, tabPage, text } from './helpers'

stopLeftoverApps()

const refOf = (s: string, label: string) => {
  const line = s.split('\n').find((l) => l.includes(label))
  const m = line && /\[(ref_\d+)\]/.exec(line)
  if (!m) throw new Error(`no ref for "${label}" in:\n${s}`)
  return m[1]
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
type Sent = { ticket: string; name: string; size: number; sha256: string }
/** a file behind a single-use ticket on the fake team server */
async function ticket(name: string, body: string | Buffer): Promise<Sent> {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const r = await fetch('http://127.0.0.1:19151/test/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, base64: b.toString('base64') }) })
  return r.json() as Promise<Sent>
}
const hits = async () => ((await (await fetch('http://127.0.0.1:19151/test/upload-hits')).json()) as { hits: { ticket: string; session: boolean }[] }).hits
const expected = (files: { name: string; body: string | Buffer }[]) => files.map((f) => { const b = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body); return { name: f.name, size: b.length, sha256: sha(b) } })
const inPage = (tab: Page, id: string) => tab.evaluate((i) => (window as any).filesOf((document.getElementById(i) as HTMLInputElement).files), id)

test.describe('file_upload in the browser pane', () => {
  test.describe.configure({ mode: 'serial' })
  let app: ElectronApplication
  let tab: Page
  let root: string
  test.beforeAll(async () => {
    // crypto.subtle needs a secure origin: the shop is treated as one (as clear-storage.spec.ts does)
    app = await launch(newUserData(), {}, [`--unsafely-treat-insecure-origin-as-secure=${SHOP}`])
    await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    root = join(await app.evaluate(({ app: a }) => a.getPath('userData')), `${PRODUCT.id}-up`)
    newTurn()
    const { callId } = await call(ACME, 'navigate', { url: `${SHOP}/upload.html` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, callId)).result.ok).toBe(true)
    tab = await tabPage(app, (u) => u.startsWith(`${SHOP}/upload.html`))
  })
  test.afterAll(async () => close(app))
  const find = async (q: string) => refOf(text(await run(ACME, 'find', { query: q })), q)

  test('a visible multi-file field: both files, names in Korean, the bytes intact in the page', async () => {
    const files = [{ name: '견적서 A.pdf', body: '%PDF-1.4 quote A' }, { name: '사업자등록증.pdf', body: Buffer.from([0, 1, 2, 250, 251, 252]) }]
    const sent = await Promise.all(files.map((f) => ticket(f.name, f.body)))
    const r = await run(ACME, 'file_upload', { ref: await find('첨부 파일 여러 개'), files: sent })
    expect(r.result.ok, text(r)).toBe(true)
    expect(text(r)).toContain("Attached 2 files to shop.test:19153 (견적서 A.pdf, 사업자등록증.pdf) through the page's file field.")
    expect(await inPage(tab, 'multi')).toEqual(expected(files))
    expect(await tab.evaluate(() => (window as any).changes.multi)).toBeGreaterThanOrEqual(1)
    // fetched once each, through the team page's session
    const h = (await hits()).filter((x) => sent.some((s) => s.ticket === x.ticket))
    expect(h.map((x) => x.session)).toEqual([true, true])
  })

  test('the hidden field behind a 파일첨부 button: auto finds the field; how: chooser takes the picker its click opens (no system window)', async () => {
    const files = [{ name: 'a.txt', body: 'first' }]
    const r = await run(ACME, 'file_upload', { ref: await find('파일첨부'), files: [await ticket('a.txt', 'first')] })
    expect(text(r)).toContain("through the page's file field")
    expect(await inPage(tab, 'hidden')).toEqual(expected(files))
    const more = [{ name: 'b.txt', body: 'second' }, { name: 'c.txt', body: 'third' }]
    const r2 = await run(ACME, 'file_upload', { ref: await find('파일첨부'), how: 'chooser', files: await Promise.all(more.map((f) => ticket(f.name, f.body))) })
    expect(r2.result.ok, text(r2)).toBe(true)
    expect(text(r2)).toContain('through the file picker the click opened')
    expect(await inPage(tab, 'hidden')).toEqual(expected(more))
  })

  test('a field inside its label; a one-file field refuses two files and keeps nothing', async () => {
    const one = [{ name: '이력서.docx', body: 'resume' }]
    const r = await run(ACME, 'file_upload', { ref: await find('이력서 올리기'), files: [await ticket('이력서.docx', 'resume')] })
    expect(r.result.ok, text(r)).toBe(true)
    expect(await inPage(tab, 'inlabel')).toEqual(expected(one))
    const { callId } = await call(ACME, 'file_upload', { ref: await find('사진 한 장'), files: [await ticket('p1.jpg', 'x'), await ticket('p2.jpg', 'y')] })
    const bad = await result(ACME, callId)
    expect(bad.result.ok).toBe(false)
    expect(text(bad)).toContain('That file field takes one file, and this call has 2.')
    expect(await inPage(tab, 'one')).toEqual([])
    expect(existsSync(join(root, callId))).toBe(false)
  })

  test('a drop area (no field, no picker): the files are dropped on it', async () => {
    const files = [{ name: 'drop.csv', body: 'a,b\n1,2\n' }]
    const r = await run(ACME, 'file_upload', { ref: await find('여기에 끌어다 놓기'), files: [await ticket('drop.csv', 'a,b\n1,2\n')] })
    expect(r.result.ok, text(r)).toBe(true)
    expect(text(r)).toContain('as a drop on that spot')
    expect(await tab.evaluate(() => (window as any).filesOf((window as any).dropped))).toEqual(expected(files))
  })

  test('a computer click that opens a file picker: closed, nothing chosen, and the AI hears how to attach', async () => {
    const before = await inPage(tab, 'multi')
    const r = await run(ACME, 'computer', { action: 'left_click', ref: await find('첨부 파일 여러 개') })
    expect(text(r)).toContain('A file picker opened on this page and was closed without choosing anything')
    expect(await inPage(tab, 'multi')).toEqual(before)
  })

  test('a site not allowed in this answer: the site question comes before any file is fetched; declined, nothing is fetched', async () => {
    newTurn()
    const sent = await ticket('secret.pdf', 'never')
    const { callId } = await call(ACME, 'file_upload', { ref: 'ref_1', files: [sent] })
    await expect((await chrome(app)).getByTestId('permission-prompt').first()).toBeVisible()
    await answer(app, '거부', 'site')
    const r = await result(ACME, callId)
    expect(r.result.ok).toBe(false)
    expect((await hits()).some((x) => x.ticket === sent.ticket)).toBe(false)
    // the next answer may use the site again (a fresh turn and an allow)
    newTurn()
    const again = await call(ACME, 'find', { query: '파일첨부' })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, again.callId)).result.ok).toBe(true)
  })

  test('the page uploads the files after the call (they stay on disk), and they are gone when the tab closes', async () => {
    const want = expected([{ name: 'b.txt', body: 'second' }, { name: 'c.txt', body: 'third' }])
    await tab.click('#send')
    await expect.poll(() => tab.evaluate(() => document.getElementById('sent')!.textContent)).toBe(JSON.stringify(want))
    expect(readdirSync(root).length).toBeGreaterThan(0)
    const ctx = JSON.parse(text(await run(ACME, 'tabs_context')).split('\nThe browser pane')[0]!) as { tabs: { tabId: string }[] }
    for (const t of ctx.tabs) await run(ACME, 'tabs_close', { tabId: t.tabId })
    await expect.poll(() => (existsSync(root) ? readdirSync(root).length : 0)).toBe(0)
  })
})
