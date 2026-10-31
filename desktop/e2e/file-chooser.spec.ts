// Upload / Attach in the Mac App Store build (app-window.ts answerFileChoosers): the app answers the team page's
// <input type=file> with its own open dialog (replaced here) and sets the picked files on the input: several files or
// one, the accept filter, a folder picker, again after a cancel, after a reload and in another team's page. A frame
// like an artifact gets no dialog, and a page that loaded again while the dialog was open gets nothing set. The tests
// run unpacked (not a store build): MYCEL_DESKTOP_TEST_FILE_CHOOSER=1 turns the same code on.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, BETA, close, launch, newUserData } from './helpers'

/** file inputs on the team page (what each one got is kept in window.__picked) and an artifact-like frame with one */
const INPUTS = `(() => {
  window.__picked = {}
  const add = (id, attrs) => {
    const i = document.createElement('input')
    i.type = 'file'
    i.id = id
    for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v)
    i.addEventListener('change', () => (window.__picked[id] = Array.from(i.files ?? []).map((f) => f.name + ':' + f.size)))
    document.body.append(i)
  }
  add('many', { multiple: '' })
  add('icon', { accept: 'image/png,image/jpeg' })
  add('folder', { webkitdirectory: '' })
  const f = document.createElement('iframe')
  f.id = 'artifact'
  f.setAttribute('sandbox', 'allow-scripts')
  f.srcdoc = '<input type=file id=inner>'
  document.body.append(f)
})()`
const addInputs = (page: Page) => page.evaluate(INPUTS)

/** what the replaced dialog answers; reload: the team page at this origin loads again (with the same inputs) first */
type Answer = { canceled: boolean; filePaths: string[]; reload?: string }
type Shown = { properties: string[]; filters?: { name: string; extensions: string[] }[] }

/** Replace the app's open dialog: the next answer from the list each time, and what it was asked is kept. */
async function stubOpenDialog(app: ElectronApplication, answers: Answer[]) {
  await app.evaluate(({ dialog, webContents }, { list, inputs }) => {
    const g = globalThis as any
    g.__shown ??= []
    g.__answers = list
    dialog.showOpenDialog = (async (...a: any[]) => {
      g.__shown.push(a.length > 1 ? a[1] : a[0])
      const next: Answer = g.__answers.shift() ?? { canceled: true, filePaths: [] }
      const wc = next.reload && webContents.getAllWebContents().find((w) => w.getURL().startsWith(next.reload!))
      if (wc) {
        await new Promise<void>((r) => {
          wc.once('did-finish-load', () => r())
          wc.reload()
        })
        await wc.executeJavaScript(inputs)
      }
      return { canceled: next.canceled, filePaths: next.filePaths }
    }) as any
  }, { list: answers, inputs: INPUTS })
}
const shown = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__shown ?? []) as Shown[])
const picked = (page: Page, id: string) => page.evaluate((x) => ((window as any).__picked?.[x] ?? null) as string[] | null, id)

test('the team page\'s file input opens the app\'s own dialog and gets the picked files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamax-upload-'))
  const a = join(dir, 'a.txt')
  const b = join(dir, 'b.png')
  writeFileSync(a, 'A')
  writeFileSync(b, 'BB')
  // the app's lifecycle lines (main/debug.ts) say when a pick was dropped because the page changed
  const app = await launch(newUserData(), { MYCEL_DESKTOP_TEST_FILE_CHOOSER: '1', MYCEL_DESKTOP_DEBUG: '1' })
  let log = ''
  app.process().stdout?.on('data', (d) => (log += String(d)))
  try {
    let page = await addTeam(app, 'acme.localhost:19151', ACME)
    await addInputs(page)
    await stubOpenDialog(app, [{ canceled: false, filePaths: [a, b] }, { canceled: false, filePaths: [b] }, { canceled: true, filePaths: [] }, { canceled: false, filePaths: [a] }])

    await page.click('#many')
    await expect.poll(() => picked(page, 'many')).toEqual(['a.txt:1', 'b.png:2'])
    expect((await shown(app))[0]).toEqual({ properties: ['openFile', 'multiSelections'] })

    await page.click('#icon')
    await expect.poll(() => picked(page, 'icon')).toEqual(['b.png:2'])
    expect((await shown(app))[1]).toEqual({ properties: ['openFile'], filters: [{ name: 'png, jpg, jpeg', extensions: ['png', 'jpg', 'jpeg'] }] })

    // cancelled: nothing changes, and the next click asks again
    await page.click('#many')
    await expect.poll(async () => (await shown(app)).length).toBe(3)
    expect(await picked(page, 'many')).toEqual(['a.txt:1', 'b.png:2'])
    await page.click('#many')
    await expect.poll(() => picked(page, 'many')).toEqual(['a.txt:1'])

    // a folder input asks for a folder (listing the files in the picked folder is Chromium's part: it worked here
    // before, then gave up with a cancel event even for Playwright's own setInputFiles, so it is not checked)
    await stubOpenDialog(app, [{ canceled: true, filePaths: [] }])
    await page.click('#folder')
    await expect.poll(async () => (await shown(app)).length).toBe(5)
    expect((await shown(app))[4]).toEqual({ properties: ['openDirectory'] })

    // an artifact-like frame: no dialog
    await page.frameLocator('#artifact').locator('#inner').click()
    await page.waitForTimeout(1000)
    expect(await shown(app)).toHaveLength(5)

    // after a reload (a new document in the same view)
    await page.reload()
    await addInputs(page)
    await stubOpenDialog(app, [{ canceled: false, filePaths: [b] }])
    await page.click('#many')
    await expect.poll(() => picked(page, 'many')).toEqual(['b.png:2'])

    // the page loads again while the dialog is open (a reload; a recheck moving to the office address is the same):
    // the picked file is not set (the input it was for is gone), and the next pick works on the new page
    await stubOpenDialog(app, [{ canceled: false, filePaths: [a], reload: ACME }, { canceled: false, filePaths: [a] }])
    await page.click('#many')
    await expect.poll(() => log).toContain('file chooser: the page changed while the dialog was open, nothing set')
    expect(await page.evaluate(() => (window as any).__picked)).toEqual({})
    await page.click('#icon')
    await expect.poll(() => picked(page, 'icon')).toEqual(['a.txt:1'])

    // another team (a new view)
    await page.evaluate(() => (window as any).mycelDesktop.openTeams())
    page = await addTeam(app, 'beta.localhost:19152', BETA)
    await addInputs(page)
    await stubOpenDialog(app, [{ canceled: false, filePaths: [a] }])
    await page.click('#icon')
    await expect.poll(() => picked(page, 'icon')).toEqual(['a.txt:1'])
    expect(await shown(app)).toHaveLength(9)
  } finally {
    await close(app)
  }
})
