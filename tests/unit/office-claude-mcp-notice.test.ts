// The office owner's one-time notice (QA TC-4470, server/src/office/claude-mcp-notice.ts): an installation that updated
// into "the server empties the Claude Code connections of ~/.claude.json" learns it once in Admin › Home: which ones went
// (from the audit entries, or for entries from before names were recorded, from the copy they name), where the copies are
// and the installation's command. Nothing when nothing was removed or outside the Mac's-own-sign-in mode; owners only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, UserPrefs } from '@mycel/shared/api'
import { audit } from '../../server/src/admin/audit'
import { claudeMcpBackupDir, guardOfficeClaudeJson, listMcpBackups } from '../../server/src/engine/claude-json-guard'
import { claudeMcpNotice, NOTICE_NAMES } from '../../server/src/office/claude-mcp-notice'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'office-claude-mcp-notice')
let n = 0
function fakeMac(cfg: Record<string, unknown> | null) {
  const base = path.join(BASE, `m${++n}`)
  fs.rmSync(base, { recursive: true, force: true })
  const home = path.join(base, 'home'), inst = path.join(home, 'TeamAX')
  fs.mkdirSync(path.join(home, '.claude', 'backups'), { recursive: true })
  if (cfg) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(cfg), { mode: 0o600 })
  return { base, home, inst }
}
const officeCtx = (inst: string, db: ReturnType<typeof openDb>, authMode = 'local-login') =>
  ({ config: { office: true, dataDir: path.join(inst, 'data'), teamRoot: path.join(inst, 'team'), engine: { authMode } } as any, db, log: silentLogger })
const config = () => ({
  userID: 'u-1', oauthAccount: { emailAddress: 'owner@example.com' },
  mcpServers: { github: { command: 'npx', args: ['gh-mcp'], env: { GITHUB_TOKEN: 'canary-token' } }, notes: { type: 'http', url: 'https://mcp.example.com/notes' } },
  projects: { '/Users/owner/web': { enabledMcpjsonServers: ['browser'] }, '/Users/owner/ops': { enableAllProjectMcpServers: true } },
})

beforeAll(() => { fs.rmSync(BASE, { recursive: true, force: true }); fs.mkdirSync(BASE, { recursive: true }) })
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true }))

describe('what the notice says', () => {
  test('after the first removal: the connections by name, where the copy is, the installation\'s command; no secrets', () => {
    const m = fakeMac(config())
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      const ctx = officeCtx(m.inst, db)
      expect(claudeMcpNotice(ctx, m.home)).toBeNull() // nothing removed yet
      guardOfficeClaudeJson(ctx, 'start', m.home)
      const row = db.query("SELECT detail FROM audit_log WHERE action = 'engine.claude_json_mcp_removed'").get() as { detail: string }
      expect(JSON.parse(row.detail).names).toEqual(['github', 'notes', 'browser'])
      const notice = claudeMcpNotice(ctx, m.home)!
      expect(notice).toMatchObject({ names: ['github', 'notes', 'browser'], moreNames: 0, backupFolder: '~/TeamAX/config/claude-mcp-backups', teamax: '~/TeamAX/teamax' })
      expect(Date.parse(notice.firstAt)).toBeGreaterThan(0)
      expect(JSON.stringify(notice)).not.toContain('canary-token')
      expect(JSON.stringify(notice)).not.toContain('mcp.example.com')
      // a later removal adds its names, each once; the first time stays
      fs.writeFileSync(path.join(m.home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'x' }, linear: { command: 'y' } } }))
      guardOfficeClaudeJson(ctx, 'turn', m.home)
      expect(claudeMcpNotice(ctx, m.home)).toMatchObject({ names: ['github', 'notes', 'browser', 'linear'], firstAt: notice.firstAt })
    } finally { db.close() }
  })

  test('an entry from before names were recorded: the names come from the copy it names; a name that is not a copy is ignored', () => {
    const m = fakeMac(config())
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      const ctx = officeCtx(m.inst, db)
      guardOfficeClaudeJson(ctx, 'start', m.home)
      const copy = path.basename(listMcpBackups(claudeMcpBackupDir(ctx))[0]!)
      // as an older server wrote it: keys and the copy's name, no names
      db.query("DELETE FROM audit_log WHERE action = 'engine.claude_json_mcp_removed'").run()
      audit(db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: { when: 'start', keys: ['.claude.json: mcpServers'], backup: copy } })
      audit(db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: { when: 'turn', keys: [], backup: '../../etc/passwd' } })
      expect(claudeMcpNotice(ctx, m.home)!.names).toEqual(['github', 'notes', 'browser'])
    } finally { db.close() }
  })

  test('only settings without names went (the approval switch): said as other settings; more than 20 names are counted', () => {
    const m = fakeMac({ projects: { '/x': { enableAllProjectMcpServers: true } } })
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      const ctx = officeCtx(m.inst, db)
      guardOfficeClaudeJson(ctx, 'start', m.home)
      expect(claudeMcpNotice(ctx, m.home)).toMatchObject({ names: [], moreNames: 0 })
      const many = Object.fromEntries(Array.from({ length: NOTICE_NAMES + 5 }, (_, i) => [`server-${i}`, { command: 'c' }]))
      fs.writeFileSync(path.join(m.home, '.claude.json'), JSON.stringify({ mcpServers: many }))
      guardOfficeClaudeJson(ctx, 'turn', m.home)
      const r = claudeMcpNotice(ctx, m.home)!
      expect(r.names).toHaveLength(NOTICE_NAMES)
      expect(r.moreNames).toBe(0) // the audit entry keeps 20 names: the copy has the rest
    } finally { db.close() }
  })

  test('the setup-token mode and a non-office server: no notice, even with old entries', () => {
    const m = fakeMac(config())
    const db = openDb(path.join(m.base, 'app.db'))
    try {
      audit(db, { actor: null, action: 'engine.claude_json_mcp_removed', target: '~/.claude.json', detail: { when: 'start', keys: [], names: ['github'] } })
      expect(claudeMcpNotice(officeCtx(m.inst, db, 'subscription'), m.home)).toBeNull()
      expect(claudeMcpNotice({ ...officeCtx(m.inst, db), config: { ...officeCtx(m.inst, db).config, office: false } }, m.home)).toBeNull()
      expect(claudeMcpNotice(officeCtx(m.inst, db), m.home)!.names).toEqual(['github'])
    } finally { db.close() }
  })
})

describe('who sees it', () => {
  test('owners only; closing it is a preference that never shows it again', () => {
    expect(API.officeClaudeMcpNotice).toMatchObject({ method: 'GET', path: '/api/admin/office-claude-mcp-notice', auth: 'owner' })
    expect(UserPrefs.parse({ officeMcpNotice: 'seen' })).toEqual({ officeMcpNotice: 'seen' })
    // a value it does not know reads as absent, never hiding the other preferences
    expect(UserPrefs.parse({ officeMcpNotice: 'later', textSize: 'large' }).officeMcpNotice).toBeUndefined()
  })
})
