// Office mode automatic updates against a REAL office install (docs/OFFICE.md "자동 업데이트"), run on this Mac by
// hand. The install uses test labels and ports so it never meets the clinic's or the owner's demo service:
//
//   bash TeamAX-office-<old>/office-install.sh --prefix <P> --label app.team-ax.autoupd --app-port 49430 \
//        --lan-port 49443 --helper-port 49442 --run-dir <short dir> --no-open
//   bun tests/install/office-update-e2e.ts seed   --prefix <P>      first-run setup, a member, a team file
//   <P>/teamax update channel beta && <P>/teamax update now        (the release published to the beta channel)
//   bun tests/install/office-update-e2e.ts verify --prefix <P> --version <new> [--windows <version>]
//   (rollback: a broken newer build on a feed on this Mac, `teamax update feed http://127.0.0.1:<port>`, update now,
//    then verify --version <new> again: the old one is back)
//   bash <P>/../office-uninstall.sh --prefix <P> --delete-data --yes
//
// seed writes <P>/../e2e-seed.json (no secrets of the real clinic: a test team); verify checks the version on
// /api/health, that the owner and the member still sign in, the team file, the setup state, the update state and,
// with --windows, data/downloads (installer, latest.yml, index.json) and that /downloads/latest.yml needs a session.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const cmd = process.argv[2]
const P = path.resolve(arg('--prefix') ?? '')
if (!arg('--prefix') || !['seed', 'verify'].includes(cmd ?? '')) { console.error('usage: seed|verify --prefix <install folder> [--version V] [--windows V]'); process.exit(2) }
const env = Object.fromEntries(fs.readFileSync(path.join(P, 'config', 'office.env'), 'utf8').split('\n').filter((l) => /^TEAMAX_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const BASE = `http://127.0.0.1:${env.TEAMAX_APP_PORT}`
const SEED = path.join(path.dirname(P), 'e2e-seed.json')
let failed = 0
const check = (name: string, ok: boolean, detail: unknown = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 300)}`}`) }

async function call(method: string, p: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { accept: 'application/json', origin: BASE }
  if (method !== 'GET') headers['x-mycel-csrf'] = '1'
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const set = r.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('mycel-dev-sid=') || c.startsWith('__Host-sid='))
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text, cookie: set }
}

async function login(username: string, password: string) {
  const r = await call('POST', '/api/auth/login', { username, password })
  return r.status === 200 ? r.cookie ?? null : null
}

if (cmd === 'seed') {
  const token = fs.readFileSync(path.join(P, 'data', 'setup-token'), 'utf8').trim()
  const owner = { username: 'owner', name: 'E2E Owner', password: `river-${crypto.randomBytes(6).toString("hex")}` }
  const s = await call('POST', '/api/setup', { setupToken: token, teamName: 'Update E2E', locale: 'ko', owner })
  check('first-run setup', s.status === 200 || s.status === 201, s.text)
  const oc = await login(owner.username, owner.password)
  check('owner signs in', !!oc)
  const m = await call('POST', '/api/admin/users', { username: 'desk1', name: 'Desk One', role: 'member', groupIds: [] }, oc!)
  check('member created', m.status === 200 || m.status === 201, m.text)
  const temp = m.json?.temporaryPassword as string
  const mc = await login('desk1', temp)
  const memberPw = `lamp-${crypto.randomBytes(6).toString("hex")}`
  const ch = await call('POST', '/api/auth/password', { currentPassword: temp, newPassword: memberPw }, mc!)
  check('member sets a password', ch.status === 200 || ch.status === 204, ch.text)
  // a file in the team folder (the shared space)
  const file = path.join(P, 'team', 'e2e-update-check.txt')
  const content = `written before the update ${new Date().toISOString()}\n`
  fs.writeFileSync(file, content)
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  fs.writeFileSync(SEED, JSON.stringify({ owner, member: { username: 'desk1', password: memberPw }, file: { path: file, sha256: sha(file) }, tls: sha(path.join(P, 'tls', 'ca.crt')), env: sha(path.join(P, 'config', 'office.env')) }, null, 1), { mode: 0o600 })
  console.log(`seed written: ${SEED}`)
  process.exit(failed ? 1 : 0)
} else {
  const want = arg('--version')
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'))
  const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const h = await call('GET', '/api/health')
  check(`server answers as ${want}`, h.json?.version === want, h.text)
  check('app/VERSION', fs.readFileSync(path.join(P, 'app', 'VERSION'), 'utf8').trim() === want)
  const oc = await login(seed.owner.username, seed.owner.password)
  check('owner still signs in', !!oc)
  check('member still signs in', !!(await login(seed.member.username, seed.member.password)))
  const users = await call('GET', '/api/admin/users', undefined, oc!)
  check('both accounts in the database', JSON.stringify(users.json ?? '').includes('desk1'), users.text)
  check('team file unchanged', sha(seed.file.path) === seed.file.sha256)
  // the CA stays, unless the new version replaces it on purpose (security round 4: a CA with the bare Mac name in its
  // name constraint is made again once, the old one kept as ca.crt.old-<date>; desks on the in-office path reinstall it)
  const caSame = sha(path.join(P, 'tls', 'ca.crt')) === seed.tls
  const oldKept = fs.readdirSync(path.join(P, 'tls')).some((f) => f.startsWith('ca.crt.old-') && sha(path.join(P, 'tls', f)) === seed.tls)
  check(caSame ? 'office CA unchanged' : 'office CA replaced by the new version on purpose, the old one kept', caSame || oldKept)
  check('config/office.env unchanged', sha(path.join(P, 'config', 'office.env')) === seed.env)
  const setup = await call('GET', '/api/setup')
  check('team still set up', setup.json?.needed === false, setup.text)
  const st = await call('GET', '/api/admin/office-update', undefined, oc!)
  check('Admin > System update state', st.status === 200 && st.json?.current === want, st.text)
  console.log(`  last: ${JSON.stringify(st.json?.last)}  lastUpdate: ${JSON.stringify(st.json?.lastUpdate)}`)
  const win = arg('--windows')
  if (win) {
    const dir = path.join(P, 'data', 'downloads')
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
    const item = idx.items.find((i: any) => i.platform === 'windows')
    check(`Windows app ${win} offered (index.json)`, item?.version === win, JSON.stringify(idx))
    check('installer file there', !!item && fs.statSync(path.join(dir, item.file)).size === item.size)
    const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8')
    check('latest.yml names it', yml.includes(`version: ${win}`) && !!item && yml.includes(`path: ${item.file}`))
    const anon = await fetch(`${BASE}/downloads/latest.yml`)
    check('/downloads/latest.yml needs a session', anon.status === 401, anon.status)
    const token = oc!.split('=')[1]!
    const bearer = await fetch(`${BASE}/downloads/latest.yml`, { headers: { authorization: `Bearer ${token}` } })
    check('/downloads/latest.yml with the session as Bearer (what electron-updater sends)', bearer.status === 200 && (await bearer.text()).includes(`version: ${win}`), bearer.status)
  }
  console.log(failed ? `${failed} FAILED` : 'ALL PASS')
  process.exit(failed ? 1 : 0)
}
