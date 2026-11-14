// One loader for folder access (docs/DECISIONS.md "Folder access adds up like Google Drive (P2)"; review 1 item 2): a
// RuleSet is built only in server/src/policy/ (RuleSet.fromDb, and the methods that derive one), so every set the
// server decides with knows the limited folders and the project exceptions. Reads of folder_rules outside it are display
// or bookkeeping, listed here by file with why; "has this folder rules" is hasAccessSettings (rules or a limit).
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const SERVER = path.join(import.meta.dir, '..', '..', 'server', 'src')
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []))
const rel = (f: string) => path.relative(SERVER, f).split(path.sep).join('/')

/** Files that read folder_rules themselves, and why it does not decide access there. */
const READS_RULES: Record<string, string> = {
  'policy/access.ts': 'the loader',
  'policy/convert-additive.ts': 'the one-time conversion (reads the rows before and writes them)',
  'policy/invariants.ts': 'the invariants check',
  'admin/folders.ts': 'the write helper, rulesOf / toFolder (display), hasAccessSettings, the hashes',
  'admin/groups.ts': 'the delete of a group\'s rules',
  'admin/users.ts': 'the delete of a person\'s rules',
  'chat/members-only-once.ts': 'the one-time cleanup of role rows inside projects',
  'chat/project-access.ts': 'the rules inside a project, listed on its members screen (display)',
  'connectors/remote-mcp/groups.ts': 'a group\'s rules, listed by the connector (display)',
  'connectors/remote-mcp/tools.ts': 'the policy hash ("Access changed": every row and every limit)',
  'skills/managers.ts': 'the skill managers list (display)',
  'system/backup.ts': 'the restore copies the rows between databases',
  'db-steps.ts': 'the post-migration steps',
}

test('new RuleSet( only inside server/src/policy/', () => {
  const bad = files(SERVER).filter((f) => !rel(f).startsWith('policy/') && fs.readFileSync(f, 'utf8').includes('new RuleSet('))
  expect(bad.map(rel)).toEqual([])
})

test('folder_rules is read only by the listed files', () => {
  const readers = files(SERVER).filter((f) => /\b(FROM|JOIN)\s+folder_rules\b/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort()
  expect(readers.filter((f) => !(f in READS_RULES))).toEqual([])
})

test('"has rules" is asked through hasAccessSettings, which also counts a limit', () => {
  const hits = files(SERVER).filter((f) => fs.readFileSync(f, 'utf8').includes("SELECT 1 FROM folder_rules WHERE folder_id = ? LIMIT 1'"))
  expect(hits.map(rel)).toEqual(['admin/folders.ts'])
  const src = fs.readFileSync(path.join(SERVER, 'admin', 'folders.ts'), 'utf8')
  expect(src.match(/SELECT 1 FROM folder_rules WHERE folder_id = \? LIMIT 1/g)?.length).toBe(1)
})
