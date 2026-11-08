// The team session's folder window rules (src/main/security.ts hardenAppSession, docs/DECISIONS.md "W6") in the real
// Electron, with a hidden window and no person. A folder is dropped on the page over CDP (Input.dispatchDragEvent):
// Chromium makes a FileSystemHandle for it (getAsFileSystemHandle), runs the folder window's blocklist and asks the
// session's handlers on every read. The folder window itself is a system dialog no test can answer, so the request
// Electron sends right after a pick is sent to the session's own request handler, in the shape Electron sends it.
// Everything happens in a made-up home folder that folder-window.spec.ts creates in a temporary folder (HOME and every
// app.getPath used point into it); this file refuses to run against the computer's real home. Never point it there.
// Run WITHOUT Playwright: folder-window.spec.ts builds and starts this file.
import { app, BrowserWindow, session } from 'electron'
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { hardenAppSession } from '../../src/main/security'

const home = process.env.FOLDER_TEST_HOME ?? ''
const within = (dir: string, path: string) => {
  const r = relative(dir, path)
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r))
}
// the real home (from the account, not HOME) must not be the made-up one, nor inside it; the made-up one is temporary
const realHome = userInfo().homedir // only compared as a string: nothing at the real home is opened or resolved
if (!home || !process.env.HOME || realpathSync(process.env.HOME) !== realpathSync(home) || !within(realpathSync(tmpdir()), realpathSync(home)) || within(realpathSync(home), realHome) || within(realHome, realpathSync(home))) {
  console.error('folder-main: FOLDER_TEST_HOME (and HOME) must be a made-up home in a temporary folder')
  process.exit(2)
}
app.dock?.hide()
app.setPath('userData', process.env.FOLDER_TEST_PROFILE!)
app.setPath('home', home)
app.setPath('appData', join(home, 'Library', 'Application Support'))
app.setPath('documents', join(home, 'Documents'))
app.setPath('downloads', join(home, 'Downloads'))
// Desktop moved to the home folder itself (Windows lets people move it there): picking "Desktop" must not open home
app.setPath('desktop', home)

const PAGE = `<!doctype html><body style="margin:0;width:100vw;height:100vh"><script>
window.drops = []
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  const out = { state: 'pending' }
  window.drops.push(out)
  ;[...e.dataTransfer.items][0].getAsFileSystemHandle().then(async (h) => {
    window.handle = h
    Object.assign(out, { state: 'handle', kind: h.kind, read: await h.queryPermission({ mode: 'read' }), write: await h.queryPermission({ mode: 'readwrite' }) })
    if (!window.listIt) return
    try { const n = []; for await (const [k] of h.entries()) n.push(k); out.names = n.sort() } catch (err) { out.listError = err.name }
  }, (err) => { window.handle = null; Object.assign(out, { state: 'error', error: err.name }) })
})
// the made-up secret under the made-up home, through whatever handle the last drop gave
window.readSecret = () => !window.handle ? Promise.resolve('no handle')
  : window.handle.kind !== 'directory' ? window.handle.getFile().then((f) => 'a file of ' + f.size + ' bytes').catch((e) => e.name)
  : window.handle.getDirectoryHandle('.aws').then((d) => d.getFileHandle('credentials')).then((f) => f.getFile()).then((f) => f.text()).catch((e) => e.name)
</script></body>`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

void (async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const team = `http://127.0.0.1:${port}`
  const other = `http://localhost:${port}`
  await app.whenReady()
  for (const name of ['home', 'appData', 'desktop', 'documents', 'downloads'] as const) {
    if (!within(home, app.getPath(name))) throw new Error(`${name} is outside the made-up home`)
  }

  const ses = session.fromPartition('folder-team')
  // the handler the session got (called directly for a "pick"), and how often Chromium itself called it
  let request: ((...a: any[]) => void) | null = null
  const fromChromium: string[] = []
  const set = ses.setPermissionRequestHandler.bind(ses)
  ses.setPermissionRequestHandler = ((h: any) => {
    request = h
    return set((wc: any, permission: any, done: any, details: any) => {
      fromChromium.push(permission)
      return h(wc, permission, done, details)
    })
  }) as typeof ses.setPermissionRequestHandler
  const restricted: { path: string; action: string }[] = []
  const on = ses.on.bind(ses) as (event: string, listener: (...a: any[]) => void) => unknown
  ;(ses as any).on = (event: string, listener: (...a: any[]) => void) =>
    on(event, event !== 'file-system-access-restricted' ? listener : (e: unknown, d: { path: string }, cb: (a: string) => void) => listener(e, d, (a: string) => {
      restricted.push({ path: d.path, action: a })
      cb(a)
    }))
  hardenAppSession(ses, () => [team])

  const folder = join(app.getPath('documents'), 'company')
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
  const js = (code: string, gesture = false) => win.webContents.executeJavaScript(code, gesture)
  win.webContents.debugger.attach('1.3')
  const drop = async (path: string) => {
    if (!within(home, path)) throw new Error('only the made-up home is dropped')
    const data = { items: [], files: [path], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop']) await win.webContents.debugger.sendCommand('Input.dispatchDragEvent', { type, x: 40, y: 40, data })
    await sleep(1000)
    return js('JSON.parse(JSON.stringify(window.drops.at(-1) ?? null))')
  }
  const picked = (filePath: string, over: Record<string, unknown> = {}) =>
    new Promise<boolean>((r) => request!(win.webContents, 'fileSystem', r, { filePath, isDirectory: true, fileAccessType: 'readable', isMainFrame: true, requestingUrl: `${team}/`, ...over }))

  const out: Record<string, unknown> = {}
  await win.loadURL(team)
  await js('window.listIt = true')
  out.droppedNotPicked = await drop(folder)
  // the page asks for itself, with a click: Electron answers from the check, the request handler never hears of it
  out.askReadNotPicked = await js("window.handle.requestPermission({ mode: 'read' }).catch((e) => e.name)", true)
  out.askWriteNotPicked = await js("window.handle.requestPermission({ mode: 'readwrite' }).catch((e) => e.name)", true)
  out.pickWritable = await picked(folder, { fileAccessType: 'writable' })
  out.pickSubframe = await picked(folder, { isMainFrame: false })
  out.pickOtherOrigin = await picked(folder, { requestingUrl: `${other}/` })
  out.pick = await picked(folder)
  out.afterPick = await drop(folder)
  out.readFile = await js("window.handle.getFileHandle('a.txt').then((f) => f.getFile()).then((f) => f.text()).catch((e) => e.name)")
  out.createFile = await js("window.handle.getFileHandle('new.txt', { create: true }).then(() => 'created').catch((e) => e.name)", true)
  out.askWrite = await js("window.handle.requestPermission({ mode: 'readwrite' }).catch((e) => e.name)", true)
  out.inside = await drop(join(folder, 'sub'))
  // the home folder (here also Desktop), and a folder in Documents that is a link to home: the pick is refused
  out.pickHome = await picked(home)
  out.pickLinkToHome = await picked(join(app.getPath('documents'), 'home-link'))
  // blocked by Chromium: Downloads itself (allowed; a drop is still no pick), the home folder itself, which is Desktop
  // here (refused), app data (refused). Nothing of them is listed; the made-up secret is tried through the handle.
  await js('window.listIt = false')
  out.downloads = await drop(app.getPath('downloads'))
  out.home = await drop(home)
  out.homeSecret = await js('window.readSecret()')
  out.appData = await drop(app.getPath('appData'))
  await win.loadURL(other)
  await js('window.listIt = true')
  out.otherOrigin = await drop(folder)
  out.otherOriginDownloads = await drop(app.getPath('downloads'))
  const named: Record<string, string> = { [app.getPath('downloads')]: 'downloads', [home]: 'home', [app.getPath('appData')]: 'appData' }
  console.log('FOLDER_RESULT ' + JSON.stringify({ out, fromChromium, restricted: restricted.map((r) => ({ ...r, path: named[r.path] ?? 'other' })) }))
  win.destroy()
  server.close()
  app.exit(0)
})().catch((error) => {
  console.error(error)
  app.exit(1)
})
