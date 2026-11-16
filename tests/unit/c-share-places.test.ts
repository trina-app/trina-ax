// Where a folder share may live and what its receivers may see (server/src/files/share-places.ts;
// docs/decisions/20261116-folder-share-server.md). Pure functions over names and the projects table: no disk.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { ARCHIVE_DIR, FROM_COMPUTER_DIR, PRODUCT } from '@mycel/shared'
import { LOCALE_ORDER as LOCALES } from '@mycel/shared/api'
import { childSegs, keptNames, neverShared, receiverSees, sharePlaceBlock, withinPathLimits } from '../../server/src/files/share-places'
import { SERVER_OWN_FOLDERS } from '../../server/src/files/own-folders'
import { ATTACHMENTS_DIR } from '../../server/src/uploads/attachments-dir'

const db = new Database(':memory:')
db.run('CREATE TABLE projects (id TEXT PRIMARY KEY, folder_path TEXT NOT NULL)')
db.run("INSERT INTO projects VALUES ('p1', 'users/u1/Clients/Acme'), ('p2', 'users/u2/Other'), ('p3', 'projects/Team')")
const at = (p: string) => p.split('/')
const block = (p: string) => sharePlaceBlock(db, at(p))

describe('places that are never shared', () => {
  test('a plain folder in a person\'s own files may be shared, at any depth from 3', () => {
    expect(block('users/u1/Work')).toBeNull()
    expect(block('users/u1/Work/Q4/Drafts')).toBeNull()
    expect(neverShared(db, at('users/u1/Work'))).toBe(false)
  })
  test('the personal folder itself, users/ and every team folder are refused', () => {
    expect(block('users/u1')).toBe('root')
    expect(block('users')).toBe('root')
    for (const p of ['shared', 'shared/Docs', 'groups/sales/Q4', 'projects/Team/Files', 'skills/x', '']) expect(sharePlaceBlock(db, p ? at(p) : [])).toBe('team_folder')
  })
  test('every place the server keeps under users/<id>/, and anything inside it', () => {
    for (const name of keptNames()) {
      expect(block(`users/u1/${name}`)).toBe('system_place')
      expect(block(`users/u1/${name}/inside/deeper`)).toBe('system_place')
    }
  })
  test('(R) From this computer and the archive folder in every language', () => {
    expect(block(`users/u1/${FROM_COMPUTER_DIR}`)).toBe('system_place')
    expect(block(`users/u1/${FROM_COMPUTER_DIR}/Desktop/Reports`)).toBe('system_place')
    expect(Object.keys(ARCHIVE_DIR).sort()).toEqual([...LOCALES].sort())
    for (const L of LOCALES) {
      expect(block(`users/u1/${ARCHIVE_DIR[L]}`)).toBe('system_place')
      expect(block(`users/u1/${ARCHIVE_DIR[L]}/former-member/Work`)).toBe('system_place')
    }
  })
  test('(R) case, width and Unicode twins of a kept name are the kept name', () => {
    // U+017F LATIN SMALL LETTER LONG S folds to "s"
    expect(block('users/u1/downloadſ')).toBe('system_place')
    expect(block('users/u1/Downloads')).toBe('system_place')
    expect(block('users/u1/DOWNLOADS/x')).toBe('system_place')
    expect(block('users/u1/ｄｏｗｎｌｏａｄｓ')).toBe('system_place')
    expect(block('users/u1/ＥＸＰＯＲＴＳ/a')).toBe('system_place')
    expect(block('users/u1/FROM THIS COMPUTER')).toBe('system_place')
    // a decomposed (NFD) spelling of each language's archive name, and of a kept ASCII name with a combining twin
    for (const L of LOCALES) {
      const nfd = ARCHIVE_DIR[L].normalize('NFD')
      expect(block(`users/u1/${nfd}`)).toBe('system_place')
      expect(block(`users/u1/${nfd}/x`)).toBe('system_place')
    }
    expect('보관된 계정'.normalize('NFD')).not.toBe('보관된 계정')
    // a different name stays shareable
    expect(block('users/u1/Downloads 2')).toBeNull()
    expect(block('users/u1/My exports')).toBeNull()
  })
  test('hidden names, temp names and names the name rules refuse, at any level', () => {
    expect(block('users/u1/.secret')).toBe('system_place')
    expect(block('users/u1/Work/.git')).toBe('system_place')
    expect(block(`users/u1/Work/${PRODUCT.tmpPrefix}abc`)).toBe('system_place')
    expect(block('users/u1/Work/CON')).toBe('system_place')
    expect(block('users/u1/Work/trailing.')).toBe('system_place')
  })
  test('a project\'s folder, a folder that holds one, and anything inside one', () => {
    expect(block('users/u1/Clients/Acme')).toBe('project')
    expect(block('users/u1/Clients')).toBe('project')
    expect(block('users/u1/Clients/Acme/Files')).toBe('project')
    // another person's project and a look-alike prefix do not count
    expect(block('users/u1/Other')).toBeNull()
    expect(block('users/u1/Clients/Acme2')).toBeNull()
  })
  test('the list is built from the writers\' own constants', () => {
    const names = keptNames()
    for (const n of SERVER_OWN_FOLDERS) expect(names).toContain(n)
    for (const n of ['skills', ATTACHMENTS_DIR, 'notes.md', FROM_COMPUTER_DIR, ...Object.values(ARCHIVE_DIR)]) expect(names).toContain(n)
  })
  test('every folder name the server writes right under users/<id>/ is on the list', () => {
    // the source is read for a literal 'users/<…>/<name>' or ['users', id, '<name>'] save place: a new one must be added
    // to SERVER_OWN_FOLDERS (files/own-folders.ts) or to keptNames(), or listed here with why it is not a folder
    const notFolders = new Set(['notes.md'])
    const kept = new Set(keptNames().map((n) => n.toLowerCase()))
    const found = new Set<string>()
    const root = path.join(import.meta.dir, '../../server/src')
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.ts')) continue
        const src = fs.readFileSync(p, 'utf8')
        for (const m of src.matchAll(/\[\s*'users'\s*,\s*[A-Za-z_.$]+(?:\.id|Id)?\s*,\s*'([A-Za-z][A-Za-z0-9 _-]*)'/g)) found.add(m[1]!)
        for (const m of src.matchAll(/`users\/\$\{[^}]+\}\/([A-Za-z][A-Za-z0-9_-]*)[`/]/g)) found.add(m[1]!)
      }
    }
    walk(root)
    expect(found.size).toBeGreaterThan(0)
    const missing = [...found].filter((n) => !kept.has(n.toLowerCase()) && !notFolders.has(n))
    expect(missing).toEqual([])
  })
})

describe('what a receiver may see inside a shared folder', () => {
  test('plain children are seen; hidden, temp, kept, skill and project places are not', () => {
    expect(receiverSees(db, at('users/u1/Work'))).toBe(true)
    expect(receiverSees(db, at('users/u1/Work/a/b.txt'))).toBe(true)
    expect(receiverSees(db, at('users/u1/Work/.env'))).toBe(false)
    expect(receiverSees(db, at('users/u1/Work/.cache/x'))).toBe(false)
    expect(receiverSees(db, at(`users/u1/Work/${PRODUCT.tmpPrefix}1`))).toBe(false)
    expect(receiverSees(db, at('users/u1/downloads/x'))).toBe(false)
    expect(receiverSees(db, at('users/u1'))).toBe(false)
    expect(receiverSees(db, at('shared/x'))).toBe(false)
    // at or under a project's folder: no; the folder that only holds it: yes (its listing drops the project's folder)
    expect(receiverSees(db, at('users/u1/Clients/Acme'))).toBe(false)
    expect(receiverSees(db, at('users/u1/Clients/Acme/x.txt'))).toBe(false)
    expect(receiverSees(db, at('users/u1/Clients'))).toBe(true)
    // the projects read once for a listing give the same answers
    expect(receiverSees(db, at('users/u1/Clients/Acme'), ['users/u1/Clients/Acme'])).toBe(false)
    expect(receiverSees(db, at('users/u1/Clients/Acme'), [])).toBe(true)
  })
})

describe('a path inside a shared folder, checked before the disk', () => {
  const row = 'users/u1/Work'
  test('plain names pass; the empty path is the folder itself', () => {
    expect(childSegs(row, '')).toEqual([])
    expect(childSegs(row, 'a.txt')).toEqual(['a.txt'])
    expect(childSegs(row, 'Q4/보고서.pdf')).toEqual(['Q4', '보고서.pdf'])
  })
  test('dots, absolute, encoded, hidden, temp and odd names are refused', () => {
    for (const bad of ['..', 'a/../../x', '../x', '/etc/passwd', 'a//b', 'a/', './a', 'a/./b', '.hidden', 'a/.git/config', `${PRODUCT.tmpPrefix}x`, PRODUCT.systemDir,
      'a\0b', 'a\\b', 'a\u0001b', 'a‮b', 'a／b', 'CON', 'x.', ' lead', 'con.txt', 'ABCDEF~1'])
      expect(childSegs(row, bad)).toBeNull()
    // %2e%2e is a plain name (nothing decodes it): it passes the syntax check and is simply not found on disk
    expect(childSegs(row, '%2e%2e')).toEqual(['%2e%2e'])
    for (const bad of [null, undefined, 3, {}, ['a']]) expect(childSegs(row, bad)).toBeNull()
  })
  test('the limits apply to the whole team path, not to the part inside the folder', () => {
    // 64 segments in all: the row has 3, so 61 more pass and 62 do not
    expect(childSegs(row, Array(61).fill('d').join('/'))?.length).toBe(61)
    expect(childSegs(row, Array(62).fill('d').join('/'))).toBeNull()
    // 1024 characters in all
    const room = 1024 - row.length - 1
    const head = Array(4).fill('x'.repeat(200)).join('/') + '/'
    expect(childSegs(row, head + 'y'.repeat(room - head.length))).not.toBeNull()
    expect(childSegs(row, head + 'y'.repeat(room - head.length + 1))).toBeNull()
    // 255 bytes a name (Korean: 3 bytes a letter)
    expect(childSegs(row, '가'.repeat(85))).not.toBeNull()
    expect(childSegs(row, '가'.repeat(86))).toBeNull()
    expect(withinPathLimits(Array(64).fill('a'))).toBe(true)
    expect(withinPathLimits(Array(65).fill('a'))).toBe(false)
  })
})
