// The team session's folder window rules (src/main/security.ts hardenAppSession, docs/DECISIONS.md "W6") in the real
// Electron, with a hidden window and no person. A folder is dropped on the page over CDP (Input.dispatchDragEvent):
// Chromium makes a FileSystemHandle for it (getAsFileSystemHandle), runs the folder window's blocklist and asks the
// session's handlers on every read. The folder window itself is a system dialog no test can answer, so the request
// Electron sends right after a pick is sent to the session's own request handler, in the shape Electron sends it.
// Run WITHOUT Playwright: folder-window.spec.ts builds and starts this file.
import { app, BrowserWindow, session } from 'electron'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hardenAppSession } from '../../src/main/security'

app.dock?.hide()
app.setPath('userData', process.env.FOLDER_TEST_PROFILE!)

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
  }, (err) => Object.assign(out, { state: 'error', error: err.name }))
})
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

  const ses = session.fromPartition('folder-team')
  let request: ((...a: any[]) => void) | null = null
  const set = ses.setPermissionRequestHandler.bind(ses)
  ses.setPermissionRequestHandler = ((h: any) => set((request = h))) as typeof ses.setPermissionRequestHandler
  const restricted: { path: string; action: string }[] = []
  const on = ses.on.bind(ses) as (event: string, listener: (...a: any[]) => void) => unknown
  ;(ses as any).on = (event: string, listener: (...a: any[]) => void) =>
    on(event, event !== 'file-system-access-restricted' ? listener : (e: unknown, d: { path: string }, cb: (a: string) => void) => listener(e, d, (a: string) => {
      restricted.push({ path: d.path, action: a })
      cb(a)
    }))
  hardenAppSession(ses, () => [team])

  const folder = join(mkdtempSync(join(tmpdir(), 'folder-window-')), 'company')
  mkdirSync(join(folder, 'sub'), { recursive: true })
  writeFileSync(join(folder, 'a.txt'), 'A')
  writeFileSync(join(folder, 'sub', 'c.txt'), 'C')

  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { session: ses, contextIsolation: true, sandbox: true } })
  const js = (code: string, gesture = false) => win.webContents.executeJavaScript(code, gesture)
  win.webContents.debugger.attach('1.3')
  const drop = async (path: string) => {
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
  out.pickWritable = await picked(folder, { fileAccessType: 'writable' })
  out.pickSubframe = await picked(folder, { isMainFrame: false })
  out.pickOtherOrigin = await picked(folder, { requestingUrl: `${other}/` })
  out.pick = await picked(folder)
  out.afterPick = await drop(folder)
  out.readFile = await js("window.handle.getFileHandle('a.txt').then((f) => f.getFile()).then((f) => f.text()).catch((e) => e.name)")
  out.createFile = await js("window.handle.getFileHandle('new.txt', { create: true }).then(() => 'created').catch((e) => e.name)", true)
  out.askWrite = await js("window.handle.requestPermission({ mode: 'readwrite' }).catch((e) => e.name)", true)
  out.inside = await drop(join(folder, 'sub'))
  // blocked by Chromium: the home folder itself (allowed here, not listed: a drop is no pick) and the app data folder
  await js('window.listIt = false')
  out.home = await drop(app.getPath('home'))
  out.appData = await drop(app.getPath('appData'))
  await win.loadURL(other)
  await js('window.listIt = true')
  out.otherOrigin = await drop(folder)
  out.otherOriginHome = await drop(app.getPath('home'))
  console.log('FOLDER_RESULT ' + JSON.stringify({ out, restricted: restricted.map((r) => ({ ...r, path: r.path === app.getPath('home') ? 'home' : r.path === app.getPath('appData') ? 'appData' : 'other' })) }))
  win.destroy()
  server.close()
  app.exit(0)
})().catch((error) => {
  console.error(error)
  app.exit(1)
})
