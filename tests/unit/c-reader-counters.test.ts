// Every place in server/src that counts who reads a path, and every users/ shortcut, reviewed for folder sharing
// (docs/decisions/20261116-folder-share-widening.md; the design: docs/AGENTS/plan/20261116-1147-folder-sharing.md
// "The guard test"). A folder in a person's own files can have other readers now (files/folder-shares.ts), so "who
// reads this path" must come through the hook (files/share-readers.ts: readersAt, readerCheck, shareReaders,
// privateToMe, or chat/read-scope.ts viewersOf / widening, which use it), or be a place a folder share never reaches.
//
// The test scans server/src for the calls that count readers and the users/ shortcuts and compares them, file by file,
// with the reviewed list below. A new call, a call gone, or a new file fails here: check that it goes through the hook
// (or why it need not), then update its line with the reason.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dir, '..', '..')
/** functions that count readers (or are the hook) */
const CALLS = /\b(activePeople|readersOf|viewersOf|missingReaders|widening|roomWidening|audienceOf|viewersAdded|lostViewers|audienceChange|aiAudience|readersAmong|folderAudience|readersAt|readerCheck|shareReaders)\(/g
/** a rule check for a person in a loop or filter over people (the repo names that person p, q, x, u, who, …) */
const ACCESS = /\.access\((p|q|x|u|person|m|who|pb|pa)\b,/g
/** a shortcut that treats users/<id>/ as one person's place */
const USERS = /\[0\] === 'users'|startsWith\('users\/'\)|startsWith\(`users\//g

type Counts = Record<string, number>
/** file -> what it calls (counted), and why that is right with folder shares */
const REVIEWED: Record<string, { n: Counts; why: string }> = {
  // ---- the hook and its callers ----
  'server/src/files/share-readers.ts': { n: { shareReaders: 5, readersAt: 1, readerCheck: 1, access: 2, 'users/': 1 }, why: 'the hook itself; privateToMe is the only "only I see this" test' },
  'server/src/chat/read-scope.ts': { n: { activePeople: 5, viewersOf: 4, widening: 1, readersAt: 1, missingReaders: 1, roomWidening: 1, access: 1, 'users/': 2 }, why: 'widening target = readersAt; viewersOf counts a share source\'s people (W3); sourceOf tags share sources (W2); placeKey per share (W1); the users/ lines are sourceOf and a card label' },
  'server/src/chat/widening.ts': { n: { viewersOf: 1, readersAmong: 2, access: 1 }, why: 'readersAmong sends a share source to viewersOf; its access line is for folder and root sources (team folders)' },
  'server/src/chat/turn.ts': { n: { audienceOf: 1, folderAudience: 2, missingReaders: 3, widening: 1, readersOf: 1, 'users/': 4 }, why: 'widenNeed -> widening; withoutTeamRoomsAdminsSee -> ai-grants readersOf (readersAt); audienceOf is a project\'s (never shared, D3); folderAudience counts shares; users/ lines: an own file with no history, a group or own folder top, the team root listing, a project chat\'s own files' },
  'server/src/rooms/ai-grants.ts': { n: { activePeople: 3, folderAudience: 4, shareReaders: 1, readersOf: 1, readersAt: 1, access: 1 }, why: 'readersOf = readersAt; folderAudience adds a share\'s people as readers' },
  'server/src/chat/schedule-scope.ts': { n: { readersOf: 3, missingReaders: 1, 'users/': 1 }, why: 'readersOf from ai-grants (readersAt); a users/ save folder is never recorded: a run\'s save there is decided at the write (M3)' },
  'server/src/chat/schedule-cover.ts': { n: { readersOf: 1, missingReaders: 1 }, why: 'readersOf from ai-grants (readersAt); covers only team save folders' },
  'server/src/chat/answer-share.ts': { n: { missingReaders: 1, access: 1 }, why: 'missingReaders -> viewersOf; the access line is who may open a linked file BY PATH (a share never opens by path, D5)' },
  'server/src/chat/shared-answers.ts': { n: { viewersOf: 1 }, why: 'viewersOf (W3)' },
  'server/src/rooms/history.ts': { n: { viewersOf: 1 }, why: 'viewersOf (W3)' },
  'server/src/connectors/remote-mcp/rooms.ts': { n: { roomWidening: 1 }, why: 'roomWidening (W1)' },
  'server/src/connectors/remote-mcp/upload.ts': { n: { widening: 1, 'users/': 1 }, why: 'the connector\'s write, edit and upload_file go through widening; the users/ line finds a personal skills folder' },
  'server/src/tools/make-file.ts': { n: { widening: 1 }, why: 'widening outside a turn' },
  'server/src/team-files/html-pdf-save.ts': { n: { widening: 1 }, why: 'widening outside a turn' },
  'server/src/tools/file-moves.ts': { n: { audienceChange: 3 }, why: 'audienceChange counts a share\'s people (H3); the card\'s yes is passed to move() for W7' },
  'server/src/team-files/service.ts': { n: { activePeople: 7, readerCheck: 5, lostViewers: 3, readersOf: 3, viewersAdded: 5, audienceChange: 1, aiAudience: 3, shareReaders: 3, access: 3, 'users/': 12 }, why: 'audience, lostViewers, readersOf, viewersAdded, audienceChange through readerCheck; aiAudience adds shareReaders; restores ask (sharedSince); move() asks for a shared folder (W7). Its other access lines are a writer check and the project zone; its users/ lines are path rules (protected roots, rule folders cannot move under users/, the move confirms)' },
  'server/src/team-files/embed.ts': { n: { activePeople: 2, readerCheck: 1 }, why: 'a page and a file judged by readerCheck' },
  'server/src/devenv/srt/access.ts': { n: { audienceOf: 2, access: 1, 'users/': 2 }, why: 'audienceOf counts shareReaders (W6); runMayWrite refuses shared folders (D11); users/ lines: a run sees only its own personal folder, rules under users/ are skipped' },
  'server/src/devenv/srt/runner.ts': { n: { activePeople: 1, shareReaders: 1 }, why: 'passes the person\'s shared folders and the share readers to folderView' },
  'server/src/files/service.ts': { n: { shareReaders: 2 }, why: 'the old restore path refuses a restore into a folder shared since' },
  'server/src/files/folder-shares.ts': { n: { 'users/': 2 }, why: 'the share\'s own owner tests' },
  'server/src/files/shares.ts': { n: { access: 3, 'users/': 9 }, why: 'file shares: who may open a FILE by path or link (its own model), audit wording, the owner rule' },
  'server/src/files/share-undo.ts': { n: { 'users/': 1 }, why: 'audit wording' },
  // ---- places a folder share never reaches (projects, skills, team-folder rules, by-path access) ----
  'server/src/skills/folder-actions.ts': { n: { activePeople: 4, access: 6 }, why: 'skill folders: a skill root is never shared (D3)' },
  'server/src/skills/move.ts': { n: { activePeople: 3, access: 3 }, why: 'skill folders: never shared (D3)' },
  'server/src/skills/managers.ts': { n: { access: 4 }, why: 'skill folders: never shared (D3)' },
  'server/src/skills/suggestions.ts': { n: { 'users/': 1 }, why: 'a personal skill file: never shared (D3)' },
  'server/src/chat/skills.ts': { n: { access: 1 }, why: 'who may use a skill: skill roots are never shared (D3)' },
  'server/src/chat/skill-list.ts': { n: { 'users/': 1 }, why: 'a skill\'s name from its path' },
  'server/src/chat/project-access.ts': { n: { access: 9, 'users/': 1 }, why: 'projects: a project folder is never shared, nor inside a shared folder for its receivers (D3)' },
  'server/src/chat/project-joins.ts': { n: { access: 1 }, why: 'team projects in projects/' },
  'server/src/chat/project-leave.ts': { n: { access: 3 }, why: 'projects (never shared)' },
  'server/src/chat/project-delete.ts': { n: { 'users/': 1 }, why: 'a personal project\'s folder: path test' },
  'server/src/chat/projects.ts': { n: { 'users/': 1 }, why: 'a personal project\'s folder: path test' },
  'server/src/chat/shared.ts': { n: { access: 3 }, why: 'who sees a project\'s shared chats: its folder\'s readers (projects are never shared)' },
  'server/src/routes/chats.ts': { n: { 'users/': 2 }, why: 'a personal project\'s folder: path tests' },
  'server/src/admin/access-edit.ts': { n: { access: 7 }, why: 'team-folder rules preview (users/ carries no rules)' },
  'server/src/admin/access-explain.ts': { n: { 'users/': 1 }, why: 'users/ carries no rules' },
  'server/src/admin/folders.ts': { n: { access: 10, 'users/': 1 }, why: 'team-folder rules and their losses; a group leaver\'s sessions reset while folders are shared' },
  'server/src/routes/admin.ts': { n: { 'users/': 1 }, why: 'users/ carries no rules' },
  'server/src/auth/guests.ts': { n: { access: 1 }, why: 'a guest\'s one place (never a personal folder; guests are never on a share)' },
  'server/src/auth/guest-invites.ts': { n: { 'users/': 1 }, why: 'a guest place is never under users/' },
  'server/src/chat/runtime.ts': { n: { access: 1 }, why: 'live file events go to who reads the PATH (a receiver opens by link only)' },
  'server/src/realtime/hub.ts': { n: { access: 1 }, why: 'replayed file events: by path (a receiver opens by link only)' },
  'server/src/team-files/component.ts': { n: { access: 2 }, why: 'conflict-copy notices: by path' },
  'server/src/notifications/service.ts': { n: { access: 1 }, why: 'a notice\'s folder source: team folders' },
  'server/src/onboarding/suggestions.ts': { n: { access: 1 }, why: 'where the person may write (their own access)' },
  'server/src/policy/access.ts': { n: { access: 8, 'users/': 5 }, why: 'the folder rules themselves: users/<id>/ is its person\'s only by PATH, unchanged (D1)' },
  'server/src/policy/legacy-deepest.ts': { n: { access: 1, 'users/': 2 }, why: 'the old rule model (conversion only)' },
  'server/src/policy/convert-additive.ts': { n: { access: 4, 'users/': 1 }, why: 'rule conversion (users/ carries no rules)' },
  'server/src/policy/invariants.ts': { n: { 'users/': 1 }, why: 'rule invariants' },
  'server/src/policy/authorize.ts': { n: { 'users/': 1 }, why: 'the path walk' },
  'server/src/chat/share-places.ts': { n: { 'users/': 1 }, why: 'a card label ("my files")' },
  'server/src/chat/delete-files.ts': { n: { 'users/': 1 }, why: 'a guest\'s own folder (guests never share)' },
  'server/src/chat/prompt.ts': { n: { 'users/': 1 }, why: 'prompt wording' },
  'server/src/chat/tools.ts': { n: { 'users/': 1 }, why: 'audit wording' },
  'server/src/file-list/units.ts': { n: { 'users/': 5 }, why: 'the file lists are rendered per person by path (a receiver never lists the owner\'s folder by path)' },
  'server/src/routes/memories.ts': { n: { 'users/': 1 }, why: 'personal skills left out of a list' },
  'server/src/tools/save-url.ts': { n: { 'users/': 1 }, why: 'own() uses privateToMe after this prefix test' },
}

function scan(): Record<string, Counts> {
  const out: Record<string, Counts> = {}
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts')) {
        const rel = path.relative(ROOT, p).split(path.sep).join('/')
        // comments do not count
        const src = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
        const add = (k: string) => { const c = (out[rel] ??= {}); c[k] = (c[k] ?? 0) + 1 }
        for (const m of src.matchAll(CALLS)) add(m[1]!)
        for (const _ of src.matchAll(ACCESS)) add('access')
        for (const _ of src.matchAll(USERS)) add('users/')
      }
    }
  }
  walk(path.join(ROOT, 'server', 'src'))
  return out
}

describe('every function that counts readers and every users/ shortcut is reviewed for folder shares', () => {
  const found = scan()
  test('no file outside the reviewed list counts readers or treats users/<id>/ as one person\'s', () => {
    const unreviewed = Object.keys(found).filter((f) => !REVIEWED[f]).map((f) => `${f} ${JSON.stringify(found[f])}`)
    expect(unreviewed).toEqual([])
  })
  test('each reviewed file has exactly the calls that were reviewed (a new one must go through files/share-readers.ts)', () => {
    const changed: string[] = []
    for (const [f, r] of Object.entries(REVIEWED)) {
      const now = found[f] ?? {}
      const keys = new Set([...Object.keys(now), ...Object.keys(r.n)])
      for (const k of keys) if ((now[k] ?? 0) !== (r.n[k] ?? 0)) changed.push(`${f}: ${k} ${r.n[k] ?? 0} -> ${now[k] ?? 0}`)
    }
    expect(changed).toEqual([])
  })
  test('the writers into a personal folder are wired to the hook', () => {
    const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    // generate_video's save_as: the wider-audience card before anything is made
    expect(src('server/src/tools/higgsfield.ts')).toMatch(/confirmWidening\(asked/)
    // save_url's own(): only where nobody else reads it
    expect(src('server/src/tools/save-url.ts')).toContain('privateToMe(')
    // the restores and the person's move confirm (W7)
    expect(src('server/src/team-files/service.ts')).toMatch(/sharedSince\(r\.segs, v\.path_at_save/)
    expect(src('server/src/team-files/service.ts')).toMatch(/sharedSince\(r\.segs, t\.deleted_at\)/)
    expect(src('server/src/team-files/service.ts')).toMatch(/target\[0\] === 'users' && shareAbove\(/)
    // the dev environment: shared folders are read-only, a share add waits for a live run
    expect(src('server/src/devenv/srt/runner.ts')).toContain('ownSharedFolders(')
    expect(src('server/src/files/folder-shares.ts')).toContain('folder_share_run_active')
  })
})
