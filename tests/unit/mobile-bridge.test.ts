import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { FileTransfers, type TransferIO } from '../../mobile/src/bridge'
import { googleOAuthUrl, MAX_FILE_BYTES, parseMessage, sameTeam, safeFileName, type FileMessage } from '../../mobile/src/protocol'
import { backAction, backGestures, nativeGateLost, openScript, START_TAB_SCRIPT, swipeGate } from '../../mobile/src/nav'
const base = { v: 1 as const, nonce: 'a'.repeat(64), generation: 1, id: 'transfer-123' }
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const begin = (s: string): FileMessage => ({ ...base, type: 'file-begin', name: 'report.txt', mime: 'text/plain', size: Buffer.byteLength(s), sha256: hash(s) })
const chunk = (s: string, seq: number): FileMessage => ({ ...base, type: 'file-chunk', b64: Buffer.from(s).toString('base64'), seq })
function fixture(blockWrite = false) {
  let content = '', shared = 0, removed = 0, release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const io: TransferIO = {
    async create() { content = '' }, async append(_id, b64) { if (blockWrite) await gate; content += Buffer.from(b64, 'base64').toString() },
    async inspect() { return { size: Buffer.byteLength(content), sha256: hash(content) } },
    async share() { shared++ }, async remove() { content = ''; removed++ },
  }
  return { transfers: new FileTransfers(io, 100), release, shared: () => shared, removed: () => removed }
}
test('protocol accepts v1 bounded messages and rejects malformed/oversized structures', () => {
  expect(parseMessage(JSON.stringify(begin('hello')))).toEqual(begin('hello'))
  for (const value of [null, [], { ...begin('a'), v: 2 }, { ...begin('a'), size: MAX_FILE_BYTES + 1 },
    { ...begin('a'), sha256: 'bad' }, { ...chunk('a', 0), seq: -1 }, { ...chunk('a', 0), b64: '**' },
    { ...begin('a'), name: '../secret' }, { ...base, type: 'arbitrary-execute' }]) expect(parseMessage(JSON.stringify(value))).toBeNull()
})
test('origin checks reject opaque URLs, credentials and external origins; OAuth has an exact endpoint', () => {
  expect(sameTeam('https://team.example', 'https://team.example/files')).toBe(true)
  for (const u of ['https://evil.example', 'data:text/plain,a', 'about:blank', 'blob:https://team.example/id', 'https://x@team.example']) expect(sameTeam('https://team.example', u)).toBe(false)
  expect(googleOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?state=opaque')).toBe(true)
  for (const u of ['javascript:alert(1)', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'https://accounts.google.com/evil', 'https://u@accounts.google.com/o/oauth2/v2/auth']) expect(googleOAuthUrl(u)).toBe(false)
  expect(safeFileName('../../file.txt')).not.toContain('/')
})
test('async writes are serialized before end/hash/share and the cache is removed after share', async () => {
  const f = fixture(true)
  await f.transfers.receive(begin('firstsecond'))
  const first = f.transfers.receive(chunk('first', 0))
  const second = f.transfers.receive(chunk('second', 1))
  const end = f.transfers.receive({ ...base, type: 'file-end', seq: 2 })
  await Promise.resolve()
  expect(f.shared()).toBe(0)
  f.release(); await Promise.all([first, second, end])
  expect(f.shared()).toBe(1)
  expect(f.removed()).toBe(1)
})
test('duplicate/out-of-order chunks and wrong hash never reach sharing', async () => {
  for (const mode of ['sequence', 'hash'] as const) {
    const f = fixture()
    await f.transfers.receive(begin('expected'))
    if (mode === 'sequence') await expect(f.transfers.receive(chunk('expected', 2))).rejects.toThrow()
    else {
      await f.transfers.receive(chunk('tampered', 0))
      await expect(f.transfers.receive({ ...base, type: 'file-end', seq: 1 })).rejects.toThrow()
    }
    expect(f.shared()).toBe(0)
    expect(f.removed()).toBeGreaterThan(0)
  }
})
test('reset during an asynchronous write prevents queued end from sharing', async () => {
  const f = fixture(true)
  await f.transfers.receive(begin('a'))
  const pending = f.transfers.receive(chunk('a', 0)).catch(() => {})
  const end = f.transfers.receive({ ...base, type: 'file-end', seq: 1 }).catch(() => {})
  const cleared = f.transfers.clear()
  f.release(); await Promise.all([pending, end, cleared])
  expect(f.shared()).toBe(0)
  expect(f.removed()).toBeGreaterThan(0)
})

test('exact declared length, byte cap, duplicate begin and empty files are enforced', async () => {
  const f = fixture()
  await f.transfers.receive(begin('a'))
  await expect(f.transfers.receive(begin('a'))).rejects.toThrow()
  await expect(f.transfers.receive(chunk('too many bytes', 0))).rejects.toThrow()
  expect(f.shared()).toBe(0)
  await f.transfers.clear()
  await f.transfers.receive(begin(''))
  await f.transfers.receive({ ...base, type: 'file-end', seq: 0 })
  expect(f.shared()).toBe(1)
})

test('idle expiry removes a partially received file', async () => {
  const f = fixture()
  await f.transfers.receive(begin('a'))
  await Bun.sleep(130)
  await expect(f.transfers.receive(chunk('a', 0))).rejects.toThrow()
  expect(f.shared()).toBe(0)
  expect(f.removed()).toBeGreaterThan(0)
})

test('nav-v1: the page\'s Back state is two booleans; anything else is refused', () => {
  const nav = { ...base, type: 'nav', canGoBack: true }
  expect(parseMessage(JSON.stringify(nav))).toEqual(nav as never)
  expect(parseMessage(JSON.stringify({ ...nav, canGoBack: false, home: false }))).not.toBeNull()
  for (const over of [{ canGoBack: 'yes' }, { canGoBack: undefined }, { home: 'no' }, { home: 0 }]) expect(parseMessage(JSON.stringify({ ...nav, ...over }))).toBeNull()
})

test('nav-v1: the iOS swipe and Android Back follow the page, and stay as before until it has said', () => {
  // a page that has not said (an older server, a document loading): the WebView's own history
  expect(backGestures(null)).toBe(true)
  expect(backAction(null, true)).toBe('back')
  expect(backAction(null, false)).toBe('exit')
  // a screen under this one or an open sheet: back, whatever the WebView's own history says
  expect(backGestures({ canGoBack: true, home: true })).toBe(true)
  expect(backAction({ canGoBack: true, home: false }, false)).toBe('back')
  // a tab's root: no swipe; Android goes to the start tab, then leaves the app
  expect(backGestures({ canGoBack: false, home: false })).toBe(false)
  expect(backAction({ canGoBack: false, home: false }, true)).toBe('start-tab')
  expect(backAction({ canGoBack: false, home: true }, true)).toBe('exit')
})

test('iOS swipe at a tab\'s root: off through the module, so WebKit keeps the root\'s picture (swipe-back dark flash)', () => {
  const root = { canGoBack: false, home: false }, deeper = { canGoBack: true, home: false }
  // with the module the property stays on (WebKit records its pictures only while it is on) and the module turns the
  // swipe off at the root; a swipe back to the root then slides over its picture, not WebKit's white view
  expect(swipeGate(root, true)).toEqual({ prop: true, swipe: false })
  expect(swipeGate(deeper, true)).toEqual({ prop: true, swipe: true })
  expect(swipeGate(null, true)).toEqual({ prop: true, swipe: true })
  // without it (Android, a build without the module, or one that found nothing to set): the property, as before
  expect(swipeGate(root, false)).toEqual({ prop: false, swipe: false })
  expect(swipeGate(deeper, false)).toEqual({ prop: true, swipe: true })
  // the module never set anything while a page is on screen: back to the property; before a page said, no web view yet
  expect(nativeGateLost(0, root, false)).toBe(true)
  expect(nativeGateLost(0, null, false)).toBe(false)
  expect(nativeGateLost(2, root, false)).toBe(false)
  // it did before: a web view out of the window for a moment, the module stays
  expect(nativeGateLost(0, root, true)).toBe(false)
})

test('nav-v1: a tapped notification goes to the page\'s router, or loads the path when nothing in the page takes it', () => {
  const run = (script: string, listen?: (e: CustomEvent<{ path: string }>) => void) => {
    const win = new EventTarget() as EventTarget & { location: { assign(p: string): void } }
    const assigned: string[] = []
    win.location = { assign: p => { assigned.push(p) } }
    if (listen) win.addEventListener('mycel:open', e => listen(e as CustomEvent<{ path: string }>))
    // the script as injectJavaScript runs it (it ends with `true;`, the value react-native-webview wants)
    expect(script.endsWith(';true;')).toBe(true)
    new Function('window', 'CustomEvent', script)(win, CustomEvent)
    return assigned
  }
  // a server from before nav-v1: no listener, a load as before
  expect(run(openScript('/rooms/abc'))).toEqual(['/rooms/abc'])
  // the page took it: no load
  let heard = ''
  expect(run(openScript('/rooms/abc'), e => { heard = e.detail.path; e.preventDefault() })).toEqual([])
  expect(heard).toBe('/rooms/abc')
  // a listener that leaves it (a path it does not open itself): a load
  expect(run(openScript('/join#t=abc'), () => {})).toEqual(['/join#t=abc'])
  // the path is data, never code
  expect(run(openScript("/x');alert(1);('"))).toEqual(["/x');alert(1);('"])
  expect(START_TAB_SCRIPT).toBe("window.dispatchEvent(new CustomEvent('mycel:start-tab'));true;")
})
