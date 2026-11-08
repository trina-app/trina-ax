// The folder window on the team page in the desktop app (desktop/src/common/folder-access.ts, docs/DECISIONS.md "W6"):
// a folder the person picks is readable by the team page's top frame at the team address, never writable; another
// origin, a frame, a handle that did not come from a pick and every other permission get nothing new; Chromium's
// refused roots (home, Desktop, Documents, Downloads) are allowed, everything else it blocks stays refused.
// The same rules in the real Electron: desktop/e2e/folder-window.spec.ts.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { folderKey, FolderGrants, restrictedFolderAction, type RestrictedFolder } from '../../desktop/src/common/folder-access'

const TEAM = 'https://acme.treesoop.com'
const LAN = 'https://192.168.0.10:8443'
const ALLOWED = [TEAM, LAN]
/** what Electron sends with the request right after a pick (shape as in Electron 44's own spec) */
const picked = (filePath: string, over: Record<string, unknown> = {}) => ({ filePath, isDirectory: true, fileAccessType: 'readable', isMainFrame: true, requestingUrl: `${TEAM}/welcome`, ...over })
/** what Electron sends with a check: the grant's origin as a URL (trailing slash), no frame */
const read = (filePath: string) => ({ filePath, isDirectory: true, fileAccessType: 'readable', isMainFrame: false })
const ROOTS = ['/Users/alex', '/Users/alex/Desktop', '/Users/alex/Documents', '/Users/alex/Downloads']
const blocked = (path: string, over: Partial<RestrictedFolder> = {}): RestrictedFolder => ({ origin: `${TEAM}/`, path, isDirectory: true, isTopFrame: true, ...over })

describe('a pick (the request after the folder window)', () => {
  test('the team page\'s top frame at the team address or its office address, reading: allowed', () => {
    const g = new FolderGrants('darwin')
    expect(g.request(picked('/Users/alex/Documents/company'), ALLOWED)).toBe(true)
    expect(g.request(picked('/Users/alex/.claude', { requestingUrl: `${LAN}/` }), ALLOWED)).toBe(true)
  })

  test('another origin, a frame, a write or a request without its details: refused', () => {
    const g = new FolderGrants('darwin')
    expect(g.request(picked('/x', { requestingUrl: 'https://evil.example/' }), ALLOWED)).toBe(false)
    expect(g.request(picked('/x', { requestingUrl: 'https://acme.treesoop.com.evil.example/' }), ALLOWED)).toBe(false)
    expect(g.request(picked('/x', { requestingUrl: 'http://acme.treesoop.com/' }), ALLOWED)).toBe(false) // scheme counts
    expect(g.request(picked('/x', { requestingUrl: 'about:srcdoc' }), ALLOWED)).toBe(false)
    expect(g.request(picked('/x', { isMainFrame: false }), ALLOWED)).toBe(false)
    expect(g.request(picked('/x', { fileAccessType: 'writable' }), ALLOWED)).toBe(false)
    expect(g.request(picked('/x', { fileAccessType: undefined }), ALLOWED)).toBe(false)
    expect(g.request(picked('/x', { isMainFrame: undefined }), ALLOWED)).toBe(false)
    expect(g.request(picked(''), ALLOWED)).toBe(false)
    expect(g.request(picked('/x'), [])).toBe(false) // no team open
    // nothing refused became readable
    expect(g.check(`${TEAM}/`, read('/x'), ALLOWED)).toBe(false)
  })
})

describe('a read (the check before every read through a handle)', () => {
  test('a picked folder and what is inside it, for the origin it was picked by', () => {
    const g = new FolderGrants('darwin')
    g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company'), ALLOWED)).toBe(true)
    expect(g.check(TEAM, read('/Users/alex/Documents/company/'), ALLOWED)).toBe(true)
    // a folder picked later inside it (Chromium grants it at once and asks no request)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company/2026/q1'), ALLOWED)).toBe(true)
    // a sibling that starts with the same letters, the parent, another folder
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company-old'), ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents'), ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/.ssh'), ALLOWED)).toBe(false)
  })

  test('never a write, never another origin, and not once the origin is no longer allowed', () => {
    const g = new FolderGrants('darwin')
    g.request(picked('/Users/alex/.claude'), ALLOWED)
    expect(g.check(`${TEAM}/`, { ...read('/Users/alex/.claude'), fileAccessType: 'writable' }, ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, { filePath: '/Users/alex/.claude' }, ALLOWED)).toBe(false)
    expect(g.check('https://evil.example/', read('/Users/alex/.claude'), ALLOWED)).toBe(false)
    // the office address did not pick it: each origin has its own picks
    expect(g.check(`${LAN}/`, read('/Users/alex/.claude'), ALLOWED)).toBe(false)
    // the window moved off the office address (allowedOrigins changed): its picks stop reading
    g.request(picked('/Users/alex/.codex', { requestingUrl: `${LAN}/` }), ALLOWED)
    expect(g.check(`${LAN}/`, read('/Users/alex/.codex'), ALLOWED)).toBe(true)
    expect(g.check(`${LAN}/`, read('/Users/alex/.codex'), [TEAM])).toBe(false)
    expect(g.check('', read('/Users/alex/.codex'), ALLOWED)).toBe(false)
  })

  test('a handle that did not come from the folder window (a drop, one saved by the page in an earlier run): nothing', () => {
    // a new session's grants: nothing was picked since the app started
    expect(new FolderGrants('darwin').check(`${TEAM}/`, read('/Users/alex/Documents/company'), ALLOWED)).toBe(false)
  })

  test('Windows: either slash, any case, a drive root', () => {
    const g = new FolderGrants('win32')
    g.request(picked('C:\\Users\\Alex\\OneDrive\\Documents\\Company'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('c:/users/alex/onedrive/documents/company/Sub'), ALLOWED)).toBe(true)
    expect(g.check(`${TEAM}/`, read('C:\\Users\\Alex\\OneDrive\\Documents\\CompanyX'), ALLOWED)).toBe(false)
    g.request(picked('E:\\'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('E:\\shared\\docs'), ALLOWED)).toBe(true)
    expect(folderKey('C:\\Users\\Alex\\', 'win32')).toBe('c:\\users\\alex')
    expect(folderKey('/Users/Alex/', 'darwin')).toBe('/Users/Alex')
    expect(folderKey('/', 'linux')).toBe('/')
    expect(folderKey('C:/Users/Alex/./Docs/../', 'win32')).toBe('c:\\users\\alex')
  })

  test('. and .. are resolved before comparing: a path cannot climb out of a picked folder', () => {
    const g = new FolderGrants('darwin')
    g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company/../../.aws'), ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company/./2026/../q1'), ALLOWED)).toBe(true)
    const w = new FolderGrants('win32')
    w.request(picked('C:\\Users\\Alex\\Documents\\Company'), ALLOWED)
    expect(w.check(`${TEAM}/`, read('C:\\Users\\Alex\\Documents\\Company\\..\\..\\AppData'), ALLOWED)).toBe(false)
  })
})

describe('a folder Chromium refuses (file-system-access-restricted)', () => {
  test('exactly the home folder, Desktop, Documents and Downloads: allowed', () => {
    for (const root of ROOTS) expect(restrictedFolderAction(blocked(root), ALLOWED, ROOTS, 'darwin')).toBe('allow')
    expect(restrictedFolderAction(blocked('/Users/alex/Documents/'), ALLOWED, ROOTS, 'darwin')).toBe('allow')
    expect(restrictedFolderAction(blocked('/Users/alex/Desktop', { origin: `${LAN}/` }), ALLOWED, ROOTS, 'darwin')).toBe('allow')
    // Windows: Documents moved to OneDrive (app.getPath gives the moved folder), case and slashes as the dialog gives them
    const win = ['C:\\Users\\Alex', 'C:\\Users\\Alex\\OneDrive\\Desktop', 'C:\\Users\\Alex\\OneDrive\\Documents', 'C:\\Users\\Alex\\Downloads']
    expect(restrictedFolderAction(blocked('c:\\users\\alex\\onedrive\\documents'), ALLOWED, win, 'win32')).toBe('allow')
    expect(restrictedFolderAction(blocked('C:/Users/Alex/Downloads/'), ALLOWED, win, 'win32')).toBe('allow')
  })

  test('everything else Chromium blocks stays refused', () => {
    for (const path of ['/Users/alex/Library', '/Users/alex/Library/Application Support', '/Users/alex/.ssh', '/Users/alex/.gnupg', '/Users', '/', '/Applications', '/Users/alex/Documents/../Library', '/Users/alexander']) {
      expect(restrictedFolderAction(blocked(path), ALLOWED, ROOTS, 'darwin')).toBe('deny')
    }
    // a case that only matches on Windows
    expect(restrictedFolderAction(blocked('/users/alex/documents'), ALLOWED, ROOTS, 'darwin')).toBe('deny')
    expect(restrictedFolderAction(blocked('C:\\Windows'), ALLOWED, ['C:\\Users\\Alex'], 'win32')).toBe('deny')
  })

  test('only for a folder picked by the team page\'s top frame at an allowed origin', () => {
    const home = '/Users/alex'
    expect(restrictedFolderAction(blocked(home, { origin: 'https://evil.example/' }), ALLOWED, ROOTS, 'darwin')).toBe('deny')
    expect(restrictedFolderAction(blocked(home, { origin: 'null' }), ALLOWED, ROOTS, 'darwin')).toBe('deny')
    expect(restrictedFolderAction(blocked(home, { isTopFrame: false }), ALLOWED, ROOTS, 'darwin')).toBe('deny')
    expect(restrictedFolderAction(blocked(home, { isDirectory: false }), ALLOWED, ROOTS, 'darwin')).toBe('deny')
    expect(restrictedFolderAction(blocked(home), [], ROOTS, 'darwin')).toBe('deny')
    // a root the system could not tell (app.getPath threw): never matches
    expect(restrictedFolderAction(blocked(''), ALLOWED, ['', ''], 'darwin')).toBe('deny')
    expect(restrictedFolderAction(blocked('/Users/alex/Documents'), ALLOWED, ['', '/Users/alex/Desktop'], 'darwin')).toBe('deny')
  })
})

describe('the team session wiring (desktop/src/main/security.ts)', () => {
  const security = readFileSync(join(import.meta.dir, '../../desktop/src/main/security.ts'), 'utf8')
  const harden = security.slice(security.indexOf('export function hardenAppSession('), security.indexOf('/** Install the guards.'))

  test('fileSystem goes to the folder rules, before the page permission list; no other permission is added', () => {
    expect(security).toContain("const PAGE_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])")
    expect(harden).toContain("if (permission === 'fileSystem') return done(folders.request(details as FolderRequest, allowedOrigins()))")
    expect(harden).toContain("if (permission === 'fileSystem') return folders.check(requestingOrigin, details as FolderCheck, allowedOrigins())")
    expect(harden.indexOf("permission === 'fileSystem') return done(")).toBeLessThan(harden.indexOf('PAGE_PERMISSIONS.has(permission))'))
    // the other permissions keep their rule word for word, devices stay refused
    expect(harden).toContain('done(details.isMainFrame && allowedOrigins().includes(originOf(details.requestingUrl)) && PAGE_PERMISSIONS.has(permission))')
    expect(harden).toContain('return allowedOrigins().includes(requestingOrigin) && PAGE_PERMISSIONS.has(permission)')
    expect(harden).toContain('ses.setDevicePermissionHandler(() => false)')
    // one set of picks per team session
    expect(harden).toContain('const folders = new FolderGrants(process.platform)')
  })

  test('the restricted folder event is answered on the team session, from the top frame, with the four roots', () => {
    expect(harden).toContain("ses.on('file-system-access-restricted'")
    expect(harden).toContain('const isTopFrame = !!d.frame && d.frame.parent === null')
    expect(harden).toContain('action = restrictedFolderAction(')
    // the callback is called whatever happens (an uncalled one leaves the page's pick waiting forever), deny by default
    const listener = harden.slice(harden.indexOf("ses.on('file-system-access-restricted'"))
    expect(listener).toContain("let action: 'allow' | 'deny' = 'deny'")
    expect(listener.indexOf('try {')).toBeLessThan(listener.indexOf('const isTopFrame'))
    expect(listener.indexOf('} catch {')).toBeLessThan(listener.indexOf('callback(action)'))
    expect(listener.indexOf('} catch {')).toBeGreaterThan(listener.indexOf('action = restrictedFolderAction('))
    expect(security).toContain("(['home', 'desktop', 'documents', 'downloads'] as const)")
  })

  test('the in-app browser pane and the app\'s own screens get no folder access', () => {
    const pane = readFileSync(join(import.meta.dir, '../../desktop/src/main/pane/pane.ts'), 'utf8')
    expect(pane).toContain("const allowed = new Set(['fullscreen', 'clipboard-sanitized-write'])")
    expect(pane).not.toContain('fileSystem')
    expect(pane).not.toContain('file-system-access-restricted')
    expect(pane).not.toContain('hardenAppSession')
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toContain('s.setPermissionRequestHandler((_wc, _p, done) => done(false))')
    expect(main).toContain('s.setPermissionCheckHandler(() => false)')
    // only the team page's session gets the team rules
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win.match(/hardenAppSession\(/g)).toHaveLength(1)
    expect(win).toContain("const appSes = session.fromPartition(partitionFor(id, 'app'))")
  })

  test('the Mac App Store build keeps its own window for the page\'s file inputs', () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toContain('answerFileChoosers: answersFileChoosers(process.mas === true, app.isPackaged, process.env.MYCEL_DESKTOP_TEST_FILE_CHOOSER)')
    expect(security).not.toContain('process.mas')
  })
})

test('macOS says why the app reads Desktop, Documents and Downloads (picking there counts as consent; the text is for any prompt)', () => {
  const config = readFileSync(join(import.meta.dir, '../../desktop/electron-builder.config.ts'), 'utf8')
  for (const key of ['NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription']) expect(config).toContain(`${key}: `)
})
