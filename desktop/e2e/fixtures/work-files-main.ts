// "Find work files on this computer" in the real Electron (src/main/work-files.ts, docs/DECISIONS.md "Find work files on
// this computer"), with a hidden window and no person. The app's own consent window (main/work-consent-window.ts, tested
// on its own in work-consent.spec.ts) is replaced here by one that records what it would show and answers as the test says. The look and the
// reads then run on node:fs for real: lstat, links, realpath, O_NOFOLLOW. Everything happens in a made-up home folder
// that work-files.spec.ts creates in a temporary folder (HOME and every app.getPath used point into it); this file refuses
// to run against the computer's real home. Never point it there. Run WITHOUT Playwright: work-files.spec.ts builds and
// starts this file.
import { app, BrowserWindow } from 'electron'
import { realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { WorkFilesController } from '../../src/main/work-files'
import type { ConsentView } from '../../src/common/work-consent'

const home = process.env.FOLDER_TEST_HOME ?? ''
const within = (dir: string, path: string) => {
  const r = relative(dir, path)
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r))
}
// the real home (from the account, not HOME) must not be the made-up one, nor inside it; the made-up one is temporary
const realHome = userInfo().homedir // only compared as a string: nothing at the real home is opened or resolved
if (!home || !process.env.HOME || realpathSync(process.env.HOME) !== realpathSync(home) || !within(realpathSync(tmpdir()), realpathSync(home)) || within(realpathSync(home), realHome) || within(realHome, realpathSync(home))) {
  console.error('work-files-main: FOLDER_TEST_HOME (and HOME) must be a made-up home in a temporary folder')
  process.exit(2)
}
app.dock?.hide()
app.setPath('userData', process.env.FOLDER_TEST_PROFILE!)
app.setPath('home', home)
app.setPath('appData', join(home, 'Library', 'Application Support'))
app.setPath('documents', join(home, 'Documents'))
app.setPath('downloads', join(home, 'Downloads'))
// Desktop moved to the home folder itself (Windows lets people move it there): it must never be looked at
app.setPath('desktop', home)

const TEAM = 'http://127.0.0.1:9'
const OTHER = 'http://localhost:9'

void (async () => {
  await app.whenReady()
  for (const name of ['home', 'appData', 'desktop', 'documents', 'downloads'] as const) {
    if (!within(home, app.getPath(name))) throw new Error(`${name} is outside the made-up home`)
  }
  const asked: ConsentView[] = []
  let answer = false
  const consent = (_w: unknown, view: ConsentView) => {
    asked.push(view)
    return { result: Promise.resolve(answer), close: () => {} }
  }
  const win = new BrowserWindow({ show: false, width: 400, height: 300 })
  const progress: unknown[] = []
  const ctl = new WorkFilesController({ win: () => win, locale: () => 'en', progress: (p) => progress.push(p), consent })
  ctl.person({ signedIn: true, userId: 'u-alex' })
  const out: Record<string, unknown> = {}

  // the person says no in the app's own dialog: nothing is looked at; asked again at once, the app does not ask again
  out.cancelled = await ctl.scan(TEAM)
  out.again = await ctl.scan(TEAM)
  await new Promise((r) => setTimeout(r, 3100))
  answer = true
  const r = await ctl.scan(TEAM)
  if (r.state !== 'done') throw new Error(`no look: ${r.state}`)
  out.roots = r.roots.map((x) => ({ id: x.id, state: x.state, cut: x.cut }))
  out.names = r.files.filter((f) => f.root === 'documents').map((f) => (f.folder ? `${f.folder}/${f.name}` : f.name)).sort()
  out.downloadsListed = r.files.filter((f) => f.root === 'downloads').length
  out.leaksPath = JSON.stringify(r).includes(home) || JSON.stringify(r).includes(realpathSync(home))
  out.progress = progress.length > 0
  const id = (name: string) => r.files.find((f) => f.name === name)?.id ?? 'missing'
  const text = async (origin: string, fid: string) => {
    const x = await ctl.read(origin, fid)
    return x.ok ? Buffer.from(x.bytes).toString('utf8') : x.reason
  }
  out.read = await text(TEAM, id('Quote template.xlsx'))
  out.foreignId = await text(TEAM, 'AAAAAAAAAAAAAAAA')
  out.pathAsId = await text(TEAM, join(home, '.aws', 'credentials'))
  out.otherOrigin = await text(OTHER, id('Quote template.xlsx'))

  // a folder on the way swapped for a link to a look-alike folder (same name, size and date) after the look
  const company = join(home, 'Documents', 'company')
  const proposal = join(company, 'proposal.pdf')
  const st = statSync(proposal)
  renameSync(company, join(home, 'Documents', 'company-moved'))
  writeFileSync(join(home, 'decoy', 'proposal.pdf'), 'P'.repeat(st.size))
  utimesSync(join(home, 'decoy', 'proposal.pdf'), st.atime, st.mtime)
  symlinkSync(join(home, 'decoy'), company)
  out.swappedFolder = await text(TEAM, id('proposal.pdf'))
  // a listed file swapped for a link to the made-up secret
  const notes = join(home, 'Documents', 'notes.txt')
  renameSync(notes, `${notes}.old`)
  symlinkSync(join(home, '.aws', 'credentials'), notes)
  out.swappedFile = await text(TEAM, id('notes.txt'))

  // another person signs in: the look is forgotten
  ctl.person({ signedIn: true, userId: 'u-bo' })
  out.afterPerson = await text(TEAM, id('Quote template.xlsx'))

  console.log('WORK_RESULT ' + JSON.stringify({ out, asked }))
  win.destroy()
  app.exit(0)
})().catch((error) => {
  console.error(error)
  app.exit(1)
})
