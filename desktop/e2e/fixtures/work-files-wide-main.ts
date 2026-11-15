// Find work files, part 5, in the real Electron (src/main/work-files.ts lookWide): a made-up home with Full Disk Access
// (a made-up privacy database the probe opens), a cloud drive's folder, a work folder named like the company, a
// messenger's downloads inside Downloads, a recent-documents list pointing at a note and at Mail, and many files. The
// app's consent window is answered by the test (a recording stand-in). Everything is in a made-up home folder in a
// temporary folder that work-files-wide.spec.ts creates; this file refuses to run against the computer's real home.
import { app, BrowserWindow } from 'electron'
import { realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { WorkFilesController } from '../../src/main/work-files'
import type { ConsentView } from '../../src/common/work-consent'

const home = process.env.FOLDER_TEST_HOME ?? ''
const within = (dir: string, path: string) => {
  const r = relative(dir, path)
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r))
}
const realHome = userInfo().homedir // only compared as a string
if (!home || !process.env.HOME || realpathSync(process.env.HOME) !== realpathSync(home) || !within(realpathSync(tmpdir()), realpathSync(home)) || within(realpathSync(home), realHome) || within(realHome, realpathSync(home))) {
  console.error('work-files-wide-main: FOLDER_TEST_HOME (and HOME) must be a made-up home in a temporary folder')
  process.exit(2)
}
app.dock?.hide()
app.setPath('userData', process.env.FOLDER_TEST_PROFILE!)
app.setPath('home', home)
app.setPath('appData', join(home, 'Library', 'Application Support'))
app.setPath('documents', join(home, 'Documents'))
app.setPath('downloads', join(home, 'Downloads'))
app.setPath('desktop', join(home, 'Desktop'))

void (async () => {
  await app.whenReady()
  for (const name of ['home', 'appData', 'desktop', 'documents', 'downloads'] as const) {
    if (!within(home, app.getPath(name))) throw new Error(`${name} is outside the made-up home`)
  }
  const asked: ConsentView[] = []
  const consent = (_w: unknown, view: ConsentView) => {
    asked.push(view)
    return { result: Promise.resolve(true), close: () => {} }
  }
  const win = new BrowserWindow({ show: false, width: 400, height: 300 })
  const steps: [number, string][] = []
  let start = 0
  const ctl = new WorkFilesController({ win: () => win, locale: () => 'en', progress: (p) => { const k = `${p.root}:${p.place ?? ''}`; if (start && steps.at(-1)?.[1] !== k) steps.push([Math.round(performance.now() - start), k]) }, consent, lastInput: () => Date.now(), memory: { load: () => ({}), save: () => {} }, reading: () => {} })
  ctl.person({ signedIn: true, userId: 'u-alex' })
  const out: Record<string, unknown> = {}
  out.fullDisk = await ctl.fullDisk()
  // an older page (no wide ask): the three folders only, as before
  const narrow = await ctl.scan('http://127.0.0.1:9')
  out.narrow = narrow.state === 'done' ? [...new Set(narrow.files.map((f) => f.root))].sort() : narrow.state
  await new Promise((r) => setTimeout(r, 3100))
  const t0 = performance.now()
  start = t0
  const r = await ctl.scan('http://127.0.0.1:9', { wide: true, words: ['Acme'] })
  out.ms = Math.round(performance.now() - t0)
  out.steps = steps
  if (r.state !== 'done') throw new Error(`no look: ${r.state}`)
  out.roots = r.roots.map((x) => `${x.id}:${x.place ?? ''}:${x.state}`)
  out.count = r.files.length
  out.byRoot = r.files.reduce<Record<string, number>>((m, f) => { const k = `${f.root}:${f.place ?? ''}`; m[k] = (m[k] ?? 0) + 1; return m }, {})
  out.names = r.files.filter((f) => f.root !== 'documents' && f.root !== 'downloads' && f.root !== 'cloud').map((f) => `${f.root}:${f.place ?? ''}:${f.folder ? f.folder + '/' : ''}${f.name}`).sort()
  out.leaksPath = JSON.stringify(r).includes(home) || JSON.stringify(r).includes(realpathSync(home))
  out.mail = r.files.some((f) => f.name.includes('MAIL-ONLY'))
  const note = r.files.find((f) => f.name === 'Ideas.md')
  // the person adds it (TC-3300: only files added are read)
  if (note) ctl.add('http://127.0.0.1:9', [note.id])
  const x = note ? await ctl.read('http://127.0.0.1:9', note.id) : null
  out.readNote = x && x.ok ? Buffer.from(x.bytes).toString('utf8').slice(0, 5) : x
  console.log('WIDE_RESULT ' + JSON.stringify({ out, asked }))
  win.destroy()
  app.exit(0)
})().catch((error) => {
  console.error(error)
  app.exit(1)
})
