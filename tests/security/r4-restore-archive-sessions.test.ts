// Security regression, round 4 (office-lan 1): `teamax restore-archive --replace` brought back sign-ins that were
// ended after the archive was made. A desk PC's token that was signed out (or a session ended by a password change)
// worked again after the restore, from anywhere through the office's internet address. The admin restore already
// ended every session of the restored DB (system/backup.ts applyPendingRestore); the archive path did not.
//
// Port of scratchpad repro-restore-archive-sessions.sh without the LaunchAgent: a member signs in with a bearer
// token, the real `admin.js archive` writes the archive, the member signs out (token 401), the real
// `admin.js restore-archive` unpacks it and the office swap (swapInRestore) puts it in place, the server opens the
// restored folders again: the ended token must stay 401 while the member's password still works.
import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { swapInRestore } from '../../server/src/office/cli'
import { WORK } from '../lib/env'
import { addMember, harness, OWNER_PW, withOwner, type Harness } from '../unit/a-lib'

const NAME = 'r4-restore-archive'
const HOME = path.join(WORK, `a-${NAME}`) // the harness folder doubles as the office home (data/, team/)
const over = { dataDir: path.join(HOME, 'data'), teamRoot: path.join(HOME, 'team') }
const REPO = path.resolve(import.meta.dir, '..', '..')

function admin(args: string[]): { code: number; out: string } {
  const config = path.join(HOME, 'admin-config.json')
  if (!fs.existsSync(config)) fs.writeFileSync(config, '{}\n')
  const r = Bun.spawnSync([process.execPath, path.join(REPO, 'server/src/system/cli.ts'), ...args], {
    env: { ...process.env, MYCEL_MODE: 'dev', MYCEL_CONFIG: config, MYCEL_DATA_DIR: over.dataDir, MYCEL_TEAM_ROOT: over.teamRoot, MYCEL_LOG_LEVEL: 'error' },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() }
}

const sessionRows = (file: string) => {
  const db = new Database(file)
  try { return (db.query('SELECT count(*) AS n FROM sessions').get() as { n: number }).n } finally { db.close() }
}

describe('restore-archive ends every sign-in made before the archive', () => {
  let h: Harness | null = null
  afterAll(async () => { await h?.close() })

  test('a token signed out after the archive stays signed out after restore-archive --replace', async () => {
    h = await harness(NAME, over)
    const owner = await withOwner(h, 'olga')
    const m = await addMember(h, owner, { username: 'desk1' })
    const desk = h.client({ ip: '10.0.0.21' })
    await desk.login('desk1', m.password, 'bearer')
    const token = desk.token!
    expect((await desk.try('GET', '/api/me')).status).toBe(200)

    const archive = path.join(HOME, 'office.tar.zst')
    const a = admin(['archive', '--out', archive])
    expect(a.code, a.out).toBe(0)

    expect((await desk.try('POST', '/api/auth/logout')).status).toBe(204)
    expect((await desk.try('GET', '/api/me')).status).toBe(401)

    // an engine session stash of the replaced database
    fs.mkdirSync(path.join(over.dataDir, 'sessions', 'chat-1'), { recursive: true })
    fs.writeFileSync(path.join(over.dataDir, 'sessions', 'chat-1', 's.jsonl'), '{"secret":"old turn"}\n')

    await h.close(); h = null // the office command stops the server first
    const to = path.join(HOME, 'restore-1')
    const r = admin(['restore-archive', '--in', archive, '--to', to])
    expect(r.code, r.out).toBe(0)
    // every consumer of the unpacked folder (the office swap, a production install by hand) gets no sign-ins
    const unpacked = sessionRows(path.join(to, 'db', 'app.sqlite'))
    const kept = swapInRestore(HOME, to, 'T')

    h = await harness(NAME, over, { reuse: true }) // the server starts on the restored folders
    const stolen = h.client({ ip: '203.0.113.9' })
    stolen.token = token
    expect((await stolen.try('GET', '/api/me')).status).toBe(401) // was 200: the signed-out token was back
    expect(unpacked).toBe(0)
    expect(sessionRows(path.join(over.dataDir, 'app.db'))).toBe(0)
    expect(fs.existsSync(path.join(over.dataDir, 'sessions'))).toBe(false)
    expect(kept.sessions && fs.existsSync(path.join(kept.sessions, 'chat-1', 's.jsonl'))).toBe(true)
    // the restored data is there: the member and the owner sign in with their passwords
    const again = h.client({ ip: '10.0.0.21' })
    expect((await again.login('desk1', m.password, 'bearer')).me.user.username).toBe('desk1')
    expect((await h.client().login('olga', OWNER_PW)).me.user.username).toBe('olga')
  })
})
