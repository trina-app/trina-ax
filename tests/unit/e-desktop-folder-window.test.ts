// The folder window on the team page in the desktop app (desktop/src/common/folder-access.ts, docs/DECISIONS.md "W6"):
// a folder the person picks is readable by the team page's top frame at the team address, never writable; another
// origin, a frame, a handle that did not come from a pick and every other permission get nothing new; Chromium's
// refused roots Desktop, Documents and Downloads are allowed; the home folder and everything else it blocks stay refused.
// The same rules in the real Electron: desktop/e2e/folder-window.spec.ts.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { folderKey, FolderGrants, isUncPath, opensHome, PICKABLE_BLOCKED_ROOTS, restrictedFolderAction, type FolderIdentity, type FolderSystem, type RestrictedFolder } from '../../desktop/src/common/folder-access'

/**
 * A made-up computer: every path is a string, nothing is read. realpath answers from `links` (else the path itself);
 * identity follows links as fs.stat does and gives every folder a number of its own (one disk, case ignored on macOS
 * and Windows), unless `ids` names one (an Error: the lookup failed or took too long).
 */
function fakeSystem(home: string, platform: string, o: { links?: Record<string, string>; ids?: Record<string, FolderIdentity | Error>; realpathFails?: boolean } = {}): FolderSystem {
  const key = (p: string) => (platform === 'linux' ? folderKey(p, platform) : folderKey(p, platform).toLowerCase())
  return {
    home: () => home,
    realpath: async (p) => {
      if (o.realpathFails) throw new Error('ENOENT')
      return o.links?.[p] ?? p
    },
    identity: async (p) => {
      const named = o.ids?.[p]
      if (named instanceof Error) throw named
      if (named) return named
      const k = key(o.links?.[p] ?? p)
      let ino = 7n
      for (const c of k) ino = (ino * 131n + BigInt(c.charCodeAt(0))) % 1_000_000_000_007n
      return { dev: platform === 'win32' ? 3_029_372_109n : 16_777_232n, ino: ino + 1n }
    },
  }
}
const MAC = fakeSystem('/Users/alex', 'darwin')
const WIN = fakeSystem('C:\\Users\\Alex', 'win32')
const TEAM = 'https://acme.treesoop.com'
const LAN = 'https://192.168.0.10:8443'
const ALLOWED = [TEAM, LAN]
/** what Electron sends with the request right after a pick (shape as in Electron 44's own spec) */
const picked = (filePath: string, over: Record<string, unknown> = {}) => ({ filePath, isDirectory: true, fileAccessType: 'readable', isMainFrame: true, requestingUrl: `${TEAM}/welcome`, ...over })
/** what Electron sends with a check: the grant's origin as a URL (trailing slash), no frame */
const read = (filePath: string) => ({ filePath, isDirectory: true, fileAccessType: 'readable', isMainFrame: false })
/** app.getPath of PICKABLE_BLOCKED_ROOTS on a Mac, the way main/security.ts resolves them */
const MAC_PATHS: Record<string, string> = { home: '/Users/alex', desktop: '/Users/alex/Desktop', documents: '/Users/alex/Documents', downloads: '/Users/alex/Downloads' }
const ROOTS = PICKABLE_BLOCKED_ROOTS.map((name) => MAC_PATHS[name]!)
const blocked = (path: string, over: Partial<RestrictedFolder> = {}): RestrictedFolder => ({ origin: `${TEAM}/`, path, isDirectory: true, isTopFrame: true, ...over })

describe('a pick (the request after the folder window)', () => {
  test('the team page\'s top frame at the team address or its office address, reading: allowed', async () => {
    const g = new FolderGrants('darwin', MAC)
    expect(await g.request(picked('/Users/alex/Documents/company'), ALLOWED)).toBe(true)
    expect(await g.request(picked('/Users/alex/.claude', { requestingUrl: `${LAN}/` }), ALLOWED)).toBe(true)
  })

  test('only a folder: a single file picked with showOpenFilePicker is never remembered', async () => {
    const g = new FolderGrants('darwin', MAC)
    expect(await g.request(picked('/Users/alex/Documents/quote.pdf', { isDirectory: false }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/Users/alex/Documents/quote.pdf', { isDirectory: undefined }), ALLOWED)).toBe(false)
    // nothing was remembered, so a read of it is refused
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/quote.pdf'), ALLOWED)).toBe(false)
  })

  test('another origin, a frame, a write or a request without its details: refused', async () => {
    const g = new FolderGrants('darwin', MAC)
    expect(await g.request(picked('/x', { requestingUrl: 'https://evil.example/' }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x', { requestingUrl: 'https://acme.treesoop.com.evil.example/' }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x', { requestingUrl: 'http://acme.treesoop.com/' }), ALLOWED)).toBe(false) // scheme counts
    expect(await g.request(picked('/x', { requestingUrl: 'about:srcdoc' }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x', { isMainFrame: false }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x', { fileAccessType: 'writable' }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x', { fileAccessType: undefined }), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x', { isMainFrame: undefined }), ALLOWED)).toBe(false)
    expect(await g.request(picked(''), ALLOWED)).toBe(false)
    expect(await g.request(picked('/x'), [])).toBe(false) // no team open
    // nothing refused became readable
    expect(g.check(`${TEAM}/`, read('/x'), ALLOWED)).toBe(false)
  })
})

describe('a read (the check before every read through a handle)', () => {
  test('a picked folder and what is inside it, for the origin it was picked by', async () => {
    const g = new FolderGrants('darwin', MAC)
    await g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company'), ALLOWED)).toBe(true)
    expect(g.check(TEAM, read('/Users/alex/Documents/company/'), ALLOWED)).toBe(true)
    // a folder picked later inside it (Chromium grants it at once and asks no request)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company/2026/q1'), ALLOWED)).toBe(true)
    // a sibling that starts with the same letters, the parent, another folder
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company-old'), ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents'), ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/.ssh'), ALLOWED)).toBe(false)
  })

  test('never a write, never another origin, and not once the origin is no longer allowed', async () => {
    const g = new FolderGrants('darwin', MAC)
    await g.request(picked('/Users/alex/.claude'), ALLOWED)
    expect(g.check(`${TEAM}/`, { ...read('/Users/alex/.claude'), fileAccessType: 'writable' }, ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, { filePath: '/Users/alex/.claude' }, ALLOWED)).toBe(false)
    expect(g.check('https://evil.example/', read('/Users/alex/.claude'), ALLOWED)).toBe(false)
    // the office address did not pick it: each origin has its own picks
    expect(g.check(`${LAN}/`, read('/Users/alex/.claude'), ALLOWED)).toBe(false)
    // the window moved off the office address (allowedOrigins changed): its picks stop reading
    await g.request(picked('/Users/alex/.codex', { requestingUrl: `${LAN}/` }), ALLOWED)
    expect(g.check(`${LAN}/`, read('/Users/alex/.codex'), ALLOWED)).toBe(true)
    expect(g.check(`${LAN}/`, read('/Users/alex/.codex'), [TEAM])).toBe(false)
    expect(g.check('', read('/Users/alex/.codex'), ALLOWED)).toBe(false)
  })

  test('a handle that did not come from the folder window (a drop, one saved by the page in an earlier run): nothing', async () => {
    // a new session's grants: nothing was picked since the app started
    expect(new FolderGrants('darwin', MAC).check(`${TEAM}/`, read('/Users/alex/Documents/company'), ALLOWED)).toBe(false)
  })

  test('Windows: either slash, any case, a drive root', async () => {
    const g = new FolderGrants('win32', WIN)
    await g.request(picked('C:\\Users\\Alex\\OneDrive\\Documents\\Company'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('c:/users/alex/onedrive/documents/company/Sub'), ALLOWED)).toBe(true)
    expect(g.check(`${TEAM}/`, read('C:\\Users\\Alex\\OneDrive\\Documents\\CompanyX'), ALLOWED)).toBe(false)
    await g.request(picked('E:\\'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('E:\\shared\\docs'), ALLOWED)).toBe(true)
    expect(folderKey('C:\\Users\\Alex\\', 'win32')).toBe('c:\\users\\alex')
    expect(folderKey('/Users/Alex/', 'darwin')).toBe('/Users/Alex')
    expect(folderKey('/', 'linux')).toBe('/')
    expect(folderKey('C:/Users/Alex/./Docs/../', 'win32')).toBe('c:\\users\\alex')
  })

  test('. and .. are resolved before comparing: a path cannot climb out of a picked folder', async () => {
    const g = new FolderGrants('darwin', MAC)
    await g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company/../../.aws'), ALLOWED)).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company/./2026/../q1'), ALLOWED)).toBe(true)
    const w = new FolderGrants('win32', WIN)
    await w.request(picked('C:\\Users\\Alex\\Documents\\Company'), ALLOWED)
    expect(w.check(`${TEAM}/`, read('C:\\Users\\Alex\\Documents\\Company\\..\\..\\AppData'), ALLOWED)).toBe(false)
  })
})

describe('a folder Chromium refuses (file-system-access-restricted)', () => {
  test('exactly Desktop, Documents and Downloads: allowed', async () => {
    expect(ROOTS).toEqual(['/Users/alex/Desktop', '/Users/alex/Documents', '/Users/alex/Downloads'])
    for (const root of ROOTS) expect(await restrictedFolderAction(blocked(root), ALLOWED, ROOTS, 'darwin', MAC)).toBe('allow')
    expect(await restrictedFolderAction(blocked('/Users/alex/Documents/'), ALLOWED, ROOTS, 'darwin', MAC)).toBe('allow')
    expect(await restrictedFolderAction(blocked('/Users/alex/Desktop', { origin: `${LAN}/` }), ALLOWED, ROOTS, 'darwin', MAC)).toBe('allow')
    // Windows: Documents moved to OneDrive (app.getPath gives the moved folder), case and slashes as the dialog gives them
    const win = ['C:\\Users\\Alex\\OneDrive\\Desktop', 'C:\\Users\\Alex\\OneDrive\\Documents', 'C:\\Users\\Alex\\Downloads']
    expect(await restrictedFolderAction(blocked('c:\\users\\alex\\onedrive\\documents'), ALLOWED, win, 'win32', WIN)).toBe('allow')
    expect(await restrictedFolderAction(blocked('C:/Users/Alex/Downloads/'), ALLOWED, win, 'win32', WIN)).toBe('allow')
  })

  test('the home folder itself is refused: it would open ~/.config, ~/.aws, ~/.netrc, ~/.codex/auth.json and the like', async () => {
    // Chromium blocks only ~/.ssh, ~/.gnupg, ~/Library and app data under home, and nothing here can narrow what is
    // readable inside a pick (every read is checked against the picked folder), so home is not one of the roots
    expect(PICKABLE_BLOCKED_ROOTS).toEqual(['desktop', 'documents', 'downloads'])
    expect(PICKABLE_BLOCKED_ROOTS as readonly string[]).not.toContain('home')
    for (const path of ['/Users/alex', '/Users/alex/']) expect(await restrictedFolderAction(blocked(path), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked('C:\\Users\\Alex'), ALLOWED, ['C:\\Users\\Alex\\Desktop', 'C:\\Users\\Alex\\Documents', 'C:\\Users\\Alex\\Downloads'], 'win32', WIN)).toBe('deny')
    // folders inside home are no blocked root at all: Chromium lets the person pick them (a .claude or .codex folder)
  })

  test('everything else Chromium blocks stays refused', async () => {
    for (const path of ['/Users/alex/Library', '/Users/alex/Library/Application Support', '/Users/alex/.ssh', '/Users/alex/.gnupg', '/Users', '/', '/Applications', '/Users/alex/Documents/../Library', '/Users/alexander']) {
      expect(await restrictedFolderAction(blocked(path), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    }
    // a case that only matches on Windows
    expect(await restrictedFolderAction(blocked('/users/alex/documents'), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked('C:\\Windows'), ALLOWED, ['C:\\Users\\Alex'], 'win32', WIN)).toBe('deny')
  })

  test('only for a folder picked by the team page\'s top frame at an allowed origin', async () => {
    const docs = '/Users/alex/Documents'
    expect(await restrictedFolderAction(blocked(docs), ALLOWED, ROOTS, 'darwin', MAC)).toBe('allow')
    expect(await restrictedFolderAction(blocked(docs, { origin: 'https://evil.example/' }), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked(docs, { origin: 'null' }), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked(docs, { isTopFrame: false }), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked(docs, { isDirectory: false }), ALLOWED, ROOTS, 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked(docs), [], ROOTS, 'darwin', MAC)).toBe('deny')
    // a root the system could not tell (app.getPath threw): never matches
    expect(await restrictedFolderAction(blocked(''), ALLOWED, ['', ''], 'darwin', MAC)).toBe('deny')
    expect(await restrictedFolderAction(blocked('/Users/alex/Documents'), ALLOWED, ['', '/Users/alex/Desktop'], 'darwin', MAC)).toBe('deny')
  })
})

describe('never the home folder or a folder that holds it, whatever the path looks like (made-up paths only)', () => {
  test('Windows: Documents moved to the home folder itself, or to the drive', async () => {
    const homeAsDocs = ['C:\\Users\\Alex\\Desktop', 'C:\\Users\\Alex', 'C:\\Users\\Alex\\Downloads']
    expect(await restrictedFolderAction(blocked('C:\\Users\\Alex'), ALLOWED, homeAsDocs, 'win32', WIN)).toBe('deny')
    expect(await restrictedFolderAction(blocked('c:/users/alex/'), ALLOWED, homeAsDocs, 'win32', WIN)).toBe('deny')
    const driveAsDocs = ['C:\\Users\\Alex\\Desktop', 'C:\\', 'C:\\Users\\Alex\\Downloads']
    expect(await restrictedFolderAction(blocked('C:\\'), ALLOWED, driveAsDocs, 'win32', WIN)).toBe('deny')
    // the other roots still work
    expect(await restrictedFolderAction(blocked('C:\\Users\\Alex\\Downloads'), ALLOWED, driveAsDocs, 'win32', WIN)).toBe('allow')
    const g = new FolderGrants('win32', WIN)
    for (const path of ['C:\\Users\\Alex', 'C:\\', 'c:\\USERS', 'C:/Users/Alex/']) expect(await g.request(picked(path), ALLOWED)).toBe(false)
    expect(await g.request(picked('C:\\Users\\Alex\\Documents\\Company'), ALLOWED)).toBe(true)
  })

  test('macOS: Desktop is a link to the home folder (or to a folder above it)', async () => {
    const linked = fakeSystem('/Users/alex', 'darwin', { links: { '/Users/alex/Desktop': '/Users/alex' } })
    expect(await restrictedFolderAction(blocked('/Users/alex/Desktop'), ALLOWED, ROOTS, 'darwin', linked)).toBe('deny')
    expect(await new FolderGrants('darwin', linked).request(picked('/Users/alex/Desktop'), ALLOWED)).toBe(false)
    const up = fakeSystem('/Users/alex', 'darwin', { links: { '/Users/alex/Downloads': '/Users' } })
    expect(await restrictedFolderAction(blocked('/Users/alex/Downloads'), ALLOWED, ROOTS, 'darwin', up)).toBe('deny')
    // Documents is an ordinary folder there: still allowed
    expect(await restrictedFolderAction(blocked('/Users/alex/Documents'), ALLOWED, ROOTS, 'darwin', linked)).toBe('allow')
  })

  test('macOS: the Data volume\'s name for the same folders, and case', async () => {
    const g = new FolderGrants('darwin', MAC)
    for (const path of ['/System/Volumes/Data/Users/alex', '/System/Volumes/Data/Users', '/System/Volumes/Data', '/System/Volumes', '/System', '/Users', '/', '/users/ALEX', '/USERS']) {
      expect(await g.request(picked(path), ALLOWED)).toBe(false)
      expect(await opensHome(path, MAC, 'darwin')).toBe(true)
    }
    // a link whose target is the Data volume's name for home
    const viaData = fakeSystem('/Users/alex', 'darwin', { links: { '/Users/alex/Desktop': '/System/Volumes/Data/Users/alex' } })
    expect(await restrictedFolderAction(blocked('/Users/alex/Desktop'), ALLOWED, ROOTS, 'darwin', viaData)).toBe('deny')
    // home itself given under the Data volume's name
    expect(await opensHome('/Users/alex', fakeSystem('/System/Volumes/Data/Users/alex', 'darwin'), 'darwin')).toBe(true)
    // folders inside home are fine, under either name
    expect(await g.request(picked('/System/Volumes/Data/Users/alex/Documents/company'), ALLOWED)).toBe(true)
    expect(await g.request(picked('/Users/alex/.claude'), ALLOWED)).toBe(true)
    expect(await opensHome('/Users/alexander', MAC, 'darwin')).toBe(false)
    expect(await opensHome('/Volumes/USB', MAC, 'darwin')).toBe(false)
  })

  test('Windows: what Node returns for a mapped drive, a share, a junction and a subst drive onto the profile', async () => {
    const home = 'C:\\Users\\Alex'
    const homeId = { dev: 3_029_372_109n, ino: 1_125_899_906_842_682n }
    const sys = fakeSystem(home, 'win32', {
      links: {
        // fs.realpath on a mapped drive gives the share's network path (GetFinalPathNameByHandle)
        'H:\\': '\\\\localhost\\c$\\Users\\Alex',
        // a junction resolves to its target
        'C:\\Data\\Alex': home,
        // a subst drive, at worst left as it is
        'S:\\': 'S:\\',
        'Z:\\Docs': '\\\\nas\\company\\Docs',
        'Y:\\Docs': '\\\\nas2\\share\\Docs',
      },
      ids: {
        [home]: homeId,
        // the mapped drive and the subst drive: the same volume serial and file index as the profile folder
        'H:\\': homeId,
        'S:\\': homeId,
        // a NAS that gives no file index: Node reports 0
        'Z:\\Docs': { dev: 2_882_400_001n, ino: 0n },
        'Y:\\Docs': { dev: 2_882_400_002n, ino: 844_424_930_131_969n },
        'W:\\Docs': new Error('the file system did not answer in time'),
      },
    })
    const g = new FolderGrants('win32', sys)
    for (const path of ['H:\\', 'C:\\Data\\Alex', 'S:\\', 'Z:\\Docs', 'W:\\Docs']) {
      expect(await opensHome(path, sys, 'win32')).toBe(true)
      expect(await g.request(picked(path), ALLOWED)).toBe(false)
    }
    // a share of the profile, or any network or device path, is refused without asking the network
    for (const path of ['\\\\PC\\Users\\Alex', '\\\\nas\\company\\Docs', '//nas/company/Docs', '\\\\?\\C:\\Users\\Alex\\Documents', '\\\\.\\C:\\Users']) {
      expect(isUncPath(path, 'win32')).toBe(true)
      expect(await g.request(picked(path), ALLOWED)).toBe(false)
    }
    expect(isUncPath('//nas/company', 'darwin')).toBe(false)
    // a NAS drive that gives file numbers, and an ordinary folder, are fine
    expect(await g.request(picked('Y:\\Docs'), ALLOWED)).toBe(true)
    expect(await g.request(picked('C:\\Users\\Alex\\Documents\\Company'), ALLOWED)).toBe(true)
    // the same through the restricted folder: Documents is a junction onto the profile
    expect(await restrictedFolderAction(blocked('C:\\Data\\Alex'), ALLOWED, ['C:\\Users\\Alex\\Desktop', 'C:\\Data\\Alex', 'C:\\Users\\Alex\\Downloads'], 'win32', sys)).toBe('deny')
  })

  test('macOS and Linux: the same folder under another name is caught by its identity', async () => {
    // a bind mount or firmlink no name rule knows: same device and file number as home, or as the folder above it
    const sys = fakeSystem('/Users/alex', 'darwin', { ids: { '/Volumes/Alias/alex': { dev: 16_777_232n, ino: 999n }, '/Users/alex': { dev: 16_777_232n, ino: 999n }, '/Volumes/Alias': { dev: 16_777_232n, ino: 555n }, '/Users': { dev: 16_777_232n, ino: 555n } } })
    expect(await opensHome('/Volumes/Alias/alex', sys, 'darwin')).toBe(true)
    expect(await opensHome('/Volumes/Alias', sys, 'darwin')).toBe(true)
    expect(await opensHome('/Volumes/Alias/alex/Documents', sys, 'darwin')).toBe(false)
    // an identity of 0 cannot be told apart: refused
    const zero = fakeSystem('/home/alex', 'linux', { ids: { '/mnt/odd': { dev: 0n, ino: 12n } } })
    expect(await opensHome('/mnt/odd', zero, 'linux')).toBe(true)
    const homeZero = fakeSystem('/home/alex', 'linux', { ids: { '/home': { dev: 2049n, ino: 0n } } })
    expect(await opensHome('/srv/docs', homeZero, 'linux')).toBe(true)
  })

  test('home given through a link, and a home that cannot be told', async () => {
    const linkedHome = fakeSystem('/home/alex', 'linux', { links: { '/home/alex': '/data/alex' } })
    expect(await opensHome('/data', linkedHome, 'linux')).toBe(true)
    expect(await opensHome('/data/alex', linkedHome, 'linux')).toBe(true)
    expect(await opensHome('/data/alex/docs', linkedHome, 'linux')).toBe(false)
    // Linux compares with case
    expect(await opensHome('/HOME/alex', fakeSystem('/home/alex', 'linux'), 'linux')).toBe(false)
    // no home: nothing is allowed
    expect(await opensHome('/Users/alex/Documents/company', fakeSystem('', 'darwin'), 'darwin')).toBe(true)
    const thrower: FolderSystem = { ...MAC, home: () => { throw new Error('no home') } }
    expect(await new FolderGrants('darwin', thrower).request(picked('/Users/alex/Documents/company'), ALLOWED)).toBe(false)
    expect(await restrictedFolderAction(blocked('/Users/alex/Documents'), ALLOWED, ROOTS, 'darwin', thrower)).toBe('deny')
    // a realpath or a stat that fails (or takes too long: main/security.ts gives each a few seconds) refuses
    const broken = fakeSystem('/Users/alex', 'darwin', { realpathFails: true })
    expect(await opensHome('/Users/alex/Documents', broken, 'darwin')).toBe(true)
    const slow = fakeSystem('/Users/alex', 'darwin', { ids: { '/Users/alex/Documents/company': new Error('the file system did not answer in time') } })
    expect(await opensHome('/Users/alex/Documents/company', slow, 'darwin')).toBe(true)
    expect(await opensHome('/Users/alex/Documents/other', slow, 'darwin')).toBe(false)
  })
})

describe('the picks belong to the person who made them', () => {
  test('a pick still being checked when the person changes is not remembered', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const slow: FolderSystem = { ...MAC, identity: async (p) => { await gate; return MAC.identity(p) } }
    const g = new FolderGrants('darwin', slow)
    g.person({ signedIn: true, userId: 'u-alex' })
    const pending = g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    g.person({ signedIn: false })
    release()
    expect(await pending).toBe(false)
    expect(g.check(`${TEAM}/`, read('/Users/alex/Documents/company'), ALLOWED)).toBe(false)
  })

  test('a sign-out or another person signing in forgets them; the same person keeps them', async () => {
    const g = new FolderGrants('darwin', MAC)
    g.person({ signedIn: true, userId: 'u-alex' })
    await g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    const reads = () => g.check(`${TEAM}/`, read('/Users/alex/Documents/company'), ALLOWED)
    expect(reads()).toBe(true)
    g.person({ signedIn: true, userId: 'u-alex' })
    expect(reads()).toBe(true)
    g.person({ signedIn: true, userId: 'u-bora' })
    expect(reads()).toBe(false)
    await g.request(picked('/Users/alex/Documents/company'), ALLOWED)
    expect(reads()).toBe(true)
    g.person({ signedIn: false })
    expect(reads()).toBe(false)
  })

  test('the app tells the team session who is signed in, with every /api/me read', async () => {
    const win = readFileSync(join(import.meta.dir, '../../desktop/src/main/app-window.ts'), 'utf8')
    expect(win).toContain('this.folderGrants.set(ses, hardenAppSession(ses, () => this.allowedOrigins()))')
    const fetch = win.slice(win.indexOf('private async fetchTeamInfo()'), win.indexOf('private async fetchTeamInfo()') + 1500)
    expect(fetch).toContain('this.folderPerson({ signedIn: false })')
    expect(fetch).toContain('this.folderPerson({ signedIn: true, userId: me.data.user.id })')
  })
})

describe('the team session wiring (desktop/src/main/security.ts)', () => {
  const security = readFileSync(join(import.meta.dir, '../../desktop/src/main/security.ts'), 'utf8')
  const harden = security.slice(security.indexOf('export function hardenAppSession('), security.indexOf('/** Install the guards.'))

  test('fileSystem goes to the folder rules, before the page permission list; no other permission is added', async () => {
    expect(security).toContain("const PAGE_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])")
    expect(harden).toContain("void folders.request(details as FolderRequest, allowedOrigins()).then(done, () => done(false))")
    expect(harden).toContain("if (permission === 'fileSystem') return folders.check(requestingOrigin, details as FolderCheck, allowedOrigins())")
    expect(harden.indexOf('void folders.request(')).toBeLessThan(harden.indexOf('PAGE_PERMISSIONS.has(permission))'))
    // the other permissions keep their rule word for word, devices stay refused
    expect(harden).toContain('done(details.isMainFrame && allowedOrigins().includes(originOf(details.requestingUrl)) && PAGE_PERMISSIONS.has(permission))')
    expect(harden).toContain('return allowedOrigins().includes(requestingOrigin) && PAGE_PERMISSIONS.has(permission)')
    expect(harden).toContain('ses.setDevicePermissionHandler(() => false)')
    // one set of picks per team session
    expect(harden).toContain('const folders = new FolderGrants(process.platform, FOLDER_SYSTEM)')
    expect(harden).toContain('return folders')
    expect(security).toContain("home: () => app.getPath('home')")
    // the file system is asked off the main thread, each lookup given a few seconds (a slow network drive refuses)
    expect(security).toContain('realpath: (path) => inTime(realpath(path))')
    expect(security).toContain('identity: (path) => inTime(stat(path, { bigint: true })).then((s) => ({ dev: s.dev, ino: s.ino }))')
    expect(security).toContain('const FOLDER_LOOKUP_MS = 3000')
    expect(security).not.toMatch(/realpathSync|statSync/)
    expect(harden).toContain('process.platform, FOLDER_SYSTEM)')
  })

  test('the restricted folder event is answered on the team session, from the top frame, with the three roots', async () => {
    expect(harden).toContain("ses.on('file-system-access-restricted'")
    expect(harden).toContain('const isTopFrame = !!d.frame && d.frame.parent === null')
    expect(harden).toContain('decided = restrictedFolderAction(')
    // the callback is called whatever happens (an uncalled one leaves the page's pick waiting forever), deny by default
    const listener = harden.slice(harden.indexOf("ses.on('file-system-access-restricted'"))
    expect(listener).toContain("decided = Promise.resolve('deny')")
    expect(listener).toContain("void decided.then(callback, () => callback('deny'))")
    expect(listener.indexOf('try {')).toBeLessThan(listener.indexOf('const isTopFrame'))
    expect(listener.indexOf('} catch {')).toBeLessThan(listener.indexOf('void decided.then('))
    expect(listener.indexOf('} catch {')).toBeGreaterThan(listener.indexOf('decided = restrictedFolderAction('))
    expect(security).toContain('return PICKABLE_BLOCKED_ROOTS.map((name) => {')
    // home is no root (it is only what the roots are checked against)
    expect(security.slice(security.indexOf('function folderRoots('), security.indexOf('\n}\n', security.indexOf('function folderRoots(')))).not.toContain('home')
  })

  test('the in-app browser pane and the app\'s own screens get no folder access', async () => {
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

  test('the Mac App Store build keeps its own window for the page\'s file inputs', async () => {
    const main = readFileSync(join(import.meta.dir, '../../desktop/src/main/main.ts'), 'utf8')
    expect(main).toContain('answerFileChoosers: answersFileChoosers(process.mas === true, app.isPackaged, process.env.MYCEL_DESKTOP_TEST_FILE_CHOOSER)')
    expect(security).not.toContain('process.mas')
  })
})

test('macOS says why the app reads Desktop, Documents and Downloads (picking there counts as consent; the text is for any prompt)', async () => {
  const config = readFileSync(join(import.meta.dir, '../../desktop/electron-builder.config.ts'), 'utf8')
  for (const key of ['NSDesktopFolderUsageDescription', 'NSDocumentsFolderUsageDescription', 'NSDownloadsFolderUsageDescription']) expect(config).toContain(`${key}: `)
})
