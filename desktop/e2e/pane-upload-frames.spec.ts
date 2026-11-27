// file_upload never reaches a frame of another site (security review of #652): an allowed page (shop.test) embeds an
// attacker.test frame with a drop zone and a file field over all of it. A drop, a picker click or auto at the frame is
// refused before anything happens there, and a computer click that opens the frame's picker gets it closed (no system
// window). The frame reports every file it gets to its own server (/got): nothing arrives.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, answer, ATTACKER, call, close, launch, newTurn, newUserData, result, run, SHOP, signIn, stopLeftoverApps, tabPage, text } from './helpers'

stopLeftoverApps()

async function ticket(name: string, body: string) {
  const r = await fetch('http://127.0.0.1:19151/test/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, base64: Buffer.from(body).toString('base64') }) })
  return r.json() as Promise<{ ticket: string; name: string; size: number; sha256: string }>
}
const attackerLog = async () => ((await (await fetch(`${ATTACKER}/__log`.replace('attacker.test', '127.0.0.1'))).json()) as { log: string[] }).log

test.describe('file_upload and frames of another site', () => {
  test.describe.configure({ mode: 'serial' })
  let app: ElectronApplication
  let tab: Page
  let at: [number, number]
  test.beforeAll(async () => {
    app = await launch(newUserData())
    await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    newTurn()
    const { callId } = await call(ACME, 'navigate', { url: `${SHOP}/upload-frame.html` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, callId)).result.ok).toBe(true)
    tab = await tabPage(app, (u) => u.startsWith(`${SHOP}/upload-frame.html`))
    await expect.poll(async () => (await attackerLog()).some((u) => u.includes('/frame-loaded'))).toBe(true)
    const r = await tab.evaluate(() => { const b = document.getElementById('evil')!.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)] })
    at = r as [number, number]
  })
  test.afterAll(async () => close(app))
  const got = async () => (await attackerLog()).filter((u) => u.includes('/got'))

  for (const how of ['drop', 'chooser', 'auto'] as const) {
    test(`how: ${how} at the frame: refused, nothing reaches it`, async () => {
      const r = await run(ACME, 'file_upload', { coordinate: at, how, files: [await ticket('secret.pdf', `secret ${how}`)] })
      expect(r.result.ok).toBe(false)
      expect(text(r)).toContain('inside a frame of another site')
      await new Promise((res) => setTimeout(res, 500))
      expect(await got()).toEqual([])
    })
  }

  test('a computer click on the frame\'s file field while the AI drives: the picker is closed (no system window), nothing chosen', async () => {
    const r = await run(ACME, 'computer', { action: 'left_click', coordinate: at })
    // an out-of-process frame of another site: its own session's picker, closed
    expect(text(r)).toContain('A file picker opened inside a frame of another site')
    await new Promise((res) => setTimeout(res, 500))
    expect(await got()).toEqual([])
    // the page's own fields still take files
    const ok = await run(ACME, 'file_upload', { ref: /\[(ref_\d+)\]/.exec(text(await run(ACME, 'find', { query: '첨부 하나' })))![1], files: [await ticket('own.txt', 'own')] })
    expect(ok.result.ok, text(ok)).toBe(true)
    expect(await tab.evaluate(() => (document.getElementById('own1') as HTMLInputElement).files!.length)).toBe(1)
  })

  test('the attacker frame one level down, in a same-origin frame (border and padding) and in a srcdoc frame: refused, nothing reaches it', async () => {
    newTurn()
    const { callId } = await call(ACME, 'navigate', { url: `${SHOP}/upload-nested.html` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, callId)).result.ok).toBe(true)
    const page = await tabPage(app, (u) => u.startsWith(`${SHOP}/upload-nested.html`))
    await expect.poll(async () => (await attackerLog()).filter((u) => u.includes('/frame-loaded')).length).toBeGreaterThanOrEqual(3)
    for (const id of ['same', 'sdoc']) {
      const c = (await page.evaluate((i) => { const b = document.getElementById(i)!.getBoundingClientRect(); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)] }, id)) as [number, number]
      for (const how of ['drop', 'chooser', 'auto'] as const) {
        const r = await run(ACME, 'file_upload', { coordinate: c, how, files: [await ticket('secret.pdf', `nested ${id} ${how}`)] })
        expect(r.result.ok, `${id} ${how}: ${text(r)}`).toBe(false)
        expect(text(r)).toContain('inside a frame of another site')
      }
    }
    await new Promise((res) => setTimeout(res, 500))
    expect(await got()).toEqual([])
  })

  test('a frame of another site the page moves under the point once the drag starts: the drop is cancelled', async () => {
    newTurn()
    const { callId } = await call(ACME, 'navigate', { url: `${SHOP}/upload-moving.html` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, callId)).result.ok).toBe(true)
    const page = await tabPage(app, (u) => u.startsWith(`${SHOP}/upload-moving.html`))
    const ref = /\[(ref_\d+)\]/.exec(text(await run(ACME, 'find', { query: '여기에 놓기' })))![1]
    const r = await run(ACME, 'file_upload', { ref, how: 'drop', files: [await ticket('secret.pdf', 'moving')] })
    expect(r.result.ok, text(r)).toBe(false)
    expect(text(r)).toMatch(/moved something under that spot|inside a frame of another site/)
    await new Promise((res) => setTimeout(res, 500))
    expect(await got()).toEqual([])
    expect(await page.evaluate(() => (window as any).dropped)).toBe(0)
  })
})
