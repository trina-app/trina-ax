// Security of the scratch-folder change (docs/decisions/20261121-ai-scratch-files.md): what a project chat's scratch
// folder may be, what a shared chat's viewer learns from the summary card's folder counts, and that the AI's "own
// files" never take a neighbour's history or a sibling's path. The behaviour tests are in ai-scratch-files.test.ts.
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import type { FolderView } from '../../server/src/devenv/srt/access'
import { chatWork, settingsProblems, sharedWork, srtSettings } from '../../server/src/devenv/srt/config'
import { viewFiles, type MessageView } from '../../server/src/chat/store'
import { ownMade } from '../../server/src/chat/own-files'
import { movableRoots } from '../../server/src/devenv/bulk'
import type { AiTrashPlan } from '../../server/src/team-files/service'

const BASE = '/var/lib/mycel'
const TEAM = `${BASE}/team`
const chat = '01a1ff5b-bb07-76e0-83c6-a1574c607bf1'
const runId = 'r'.repeat(16)
const logKey = 'a'.repeat(32)

describe('the scratch folder of a project run', () => {
  // the view of a run that starts in the project folder and reads only it
  const view: FolderView = { read: ['projects/p'], write: ['projects/p'], denyRead: ['users'], denyWrite: [] }
  const input = (work: string, sharedChat: string | null) => ({ base: BASE, id: 'mycel', teamRoot: TEAM, userId: 'alice', view, start: 'projects/p', work, network: 'open' as const, extraDomains: [], denyHosts: ['team.example.com'], denyAddrs: [], platform: 'linux' as const, ...(sharedChat ? { sharedChat, runId, logKey } : {}) })

  test('a person\'s project run may have the chat\'s private work folder; the check passes', () => {
    const i = input(chatWork(BASE, chat), null)
    const s = srtSettings(i)
    expect(s.filesystem.allowWrite).toContain(chatWork(BASE, chat))
    expect(settingsProblems(s, i).filter((p) => p.includes('work folder'))).toEqual([])
  })

  test('a shared project run never gets the private work folder (it may hold copies of the person\'s own files): refused', () => {
    const bad = input(chatWork(BASE, chat), chat)
    expect(settingsProblems(srtSettings(bad), bad).some((p) => p.includes('work folder'))).toBe(true)
    const good = input(sharedWork(BASE, chat, 'k'.repeat(32)), chat)
    expect(settingsProblems(srtSettings(good), good).filter((p) => p.includes('work folder'))).toEqual([])
  })

  test('a scratch folder outside the work folders (a team folder, the base itself) is refused', () => {
    for (const w of [path.join(TEAM, 'shared'), path.join(BASE, 'devenv', 'work'), path.join(BASE, 'data')]) {
      const i = input(w, null)
      expect(settingsProblems(srtSettings(i), i).length, w).toBeGreaterThan(0)
    }
  })
})

describe('the summary card in a shared chat', () => {
  const v = (readable: string[]): MessageView => ({ viewer: 'bob', canList: () => true, canRead: (p: string) => readable.some((r) => p === r || p.startsWith(r + '/')), failed: '', locale: 'en' } as unknown as MessageView)
  const f = {
    saved: [{ path: 'projects/p/a.md', action: 'create' as const }],
    conflicts: [], rejected: [],
    more: { count: 30, folders: [{ path: 'projects/p/open', count: 10 }, { path: 'projects/p/secret', count: 20 }] },
  }
  test('only the folders whose files the viewer may read, and only their counts (a folder they can only list does not count)', () => {
    expect(viewFiles(f, v(['projects/p/open', 'projects/p/a.md']))!.more).toEqual({ count: 10, folders: [{ path: 'projects/p/open', count: 10 }] })
    const none = viewFiles(f, v([]))
    expect(none?.more).toBeUndefined()
  })
})

describe('the AI\'s own files', () => {
  const db = new Database(':memory:')
  db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, user_id TEXT NOT NULL); CREATE TABLE file_events (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT, user_id TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL, size INTEGER, sha256 TEXT, detail TEXT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))")
  db.query("INSERT INTO turns VALUES ('t1', 'c1', 'alice'), ('t2', 'c1', 'bob')").run()
  const ev = (turn: string, user: string, p: string, action = 'create') => db.query('INSERT INTO file_events (turn_id, user_id, path, action) VALUES (?, ?, ?, ?)').run(turn, user, p, action)
  const plan = (rel: string, files: string[]): Pick<AiTrashPlan, 'items'> => ({ items: [{ rel, kind: 'folder', files: files.length, folders: 0, audience: '', entries: [{ rel: '', kind: 'dir', dev: 0, ino: 0, size: 0, mtimeMs: 0 }, ...files.map((f) => ({ rel: f, kind: 'file' as const, dev: 0, ino: 0, size: 1, mtimeMs: 0 }))] }] })

  test('a sibling whose name starts the same ("tools" and "tools-2", "tools.bak") never joins the history', () => {
    ev('t1', 'alice', 'p/tools/a')
    ev('t2', 'bob', 'p/tools-2/x')
    ev('t2', 'bob', 'p/tools.bak/x')
    expect(ownMade(db, '/nonexistent', { userId: 'alice', chatId: 'c1' }, plan('p/tools', ['a'])).own).toBe(true)
    // ...but bob's file inside it does
    ev('t2', 'bob', 'p/tools/b')
    expect(ownMade(db, '/nonexistent', { userId: 'alice', chatId: 'c1' }, plan('p/tools', ['a', 'b'])).own).toBe(false)
  })

  test('another person\'s answer in the same shared chat is not "own" for this person', () => {
    ev('t2', 'bob', 'p/bobs/a')
    expect(ownMade(db, '/nonexistent', { userId: 'alice', chatId: 'c1' }, plan('p/bobs', ['a'])).own).toBe(false)
  })

  test('a skipped folder (node_modules) that is not on disk where it is said to be never counts as born with the files', () => {
    ev('t1', 'alice', 'p/nm/a')
    expect(ownMade(db, '/nonexistent', { userId: 'alice', chatId: 'c1' }, plan('p/nm', ['a', 'node_modules/x/index.js'])).own).toBe(false)
  })
})

describe('the move takes only what the command made', () => {
  test('a created path under a link is moved as itself (lstat: a link is not a folder born now), never what the link points to', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const os = require('node:os') as typeof import('node:os')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvl-'))
    fs.mkdirSync(path.join(root, 'p'), { recursive: true })
    fs.mkdirSync(path.join(root, 'outside'), { recursive: true })
    const t0 = Date.now() - 10_000
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'p', 'link'))
    expect(movableRoots(root, 'p', [{ path: 'p/link/secret', action: 'create', before: null, after: null, size: 1 }], t0)).toEqual(['link/secret'])
    // a path outside the project folder is never a root
    expect(movableRoots(root, 'p', [{ path: 'q/x', action: 'create', before: null, after: null, size: 1 }], t0)).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
