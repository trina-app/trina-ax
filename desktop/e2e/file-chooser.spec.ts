// Upload / Attach on macOS (app-window.ts answerFileChoosers): Electron opens no file chooser for a page shown in a
// WebContentsView, so the app answers the team page's <input type=file> with its own open dialog (replaced here) and
// sets the picked files on the input: several files or one, the accept filter, a folder, again after a cancel, after a
// reload and in another team's page. A frame like an artifact gets no dialog.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, BETA, close, launch, newUserData } from './helpers'

test.skip(process.platform !== 'darwin', 'the app answers file choosers itself on macOS only')

type Answer = { canceled: boolean; filePaths: string[] }
type Shown = { properties: string[]; filters?: { name: string; extensions: string[] }[] }

/** Replace the app's open dialog: the next answer from the list each time, and what it was asked is kept. */
async function stubOpenDialog(app: ElectronApplication, answers: Answer[]) {
  await app.evaluate(({ dialog }, list) => {
    const g = globalThis as any
    g.__shown ??= []
    g.__answers = list
    dialog.showOpenDialog = (async (...a: any[]) => {
      g.__shown.push(a.length > 1 ? a[1] : a[0])
      return g.__answers.shift() ?? { canceled: true, filePaths: [] }
    }) as any
  }, answers)
}
const shown = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__shown ?? []) as Shown[])

/** file inputs on the team page (what each one got is kept in window.__picked) and an artifact-like frame with one */
async function addInputs(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__picked = {}
    const add = (id: string, attrs: Record<string, string>) => {
      const i = document.createElement('input')
      i.type = 'file'
      i.id = id
      for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v)
      i.addEventListener('change', () => (w.__picked[id] = Array.from(i.files ?? []).map((f) => `${f.name}:${f.size}`)))
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
  })
}
const picked = (page: Page, id: string) => page.evaluate((x) => ((window as any).__picked?.[x] ?? null) as string[] | null, id)

test('the team page\'s file input opens the app\'s own dialog and gets the picked files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamax-upload-'))
  const a = join(dir, 'a.txt')
  const b = join(dir, 'b.png')
  writeFileSync(a, 'A')
  writeFileSync(b, 'BB')
  const app = await launch(newUserData())
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

    // a folder input picks a folder, and gets the files in it
    await stubOpenDialog(app, [{ canceled: false, filePaths: [dir] }])
    await page.click('#folder')
    await expect.poll(async () => (await picked(page, 'folder'))?.sort() ?? null).toEqual(['a.txt:1', 'b.png:2'])
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

    // another team (a new view)
    await page.evaluate(() => (window as any).mycelDesktop.openTeams())
    page = await addTeam(app, 'beta.localhost:19152', BETA)
    await addInputs(page)
    await stubOpenDialog(app, [{ canceled: false, filePaths: [a] }])
    await page.click('#icon')
    await expect.poll(() => picked(page, 'icon')).toEqual(['a.txt:1'])
    expect(await shown(app)).toHaveLength(7)
  } finally {
    await close(app)
  }
})
