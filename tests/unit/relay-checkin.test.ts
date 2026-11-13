// relay/deploy/relay-checkin.sh: the Sentry cron check-in wrapper of the relay's timers. A fake `curl` first on PATH
// records what would be sent (fictional keys only: nothing reaches Sentry). The job's exit code and output are kept
// whatever happens to the check-in, and no key means no curl at all.
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkInUrl } from '../../shared/src/sentry-report.ts'

const ROOT = path.resolve(import.meta.dir, '../..')
const SCRIPT = path.join(ROOT, 'relay/deploy/relay-checkin.sh')
const DSN = 'https://0123abcd@o1.ingest.example.test/42'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-checkin-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** a fake curl: one line per call with its arguments (NUL-separated), exit code from FAKE_CURL_EXIT */
const bin = path.join(tmp, 'bin')
fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'curl'), '#!/usr/bin/env bash\nprintf "%s\\0" "$@" >> "$FAKE_CURL_LOG"; printf "\\n" >> "$FAKE_CURL_LOG"; exit "${FAKE_CURL_EXIT:-0}"\n', { mode: 0o755 })

let n = 0
function run(args: string[], env: Record<string, string> = {}) {
  const log = path.join(tmp, `curl-${++n}.log`)
  const envFile = path.join(tmp, `relay-${n}.env`)
  fs.writeFileSync(envFile, '')
  const p = Bun.spawnSync(['bash', SCRIPT, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_CURL_LOG: log, RELAY_ENV_FILE: envFile, ...env },
  })
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\0').filter(Boolean)) : []
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), calls, envFile }
}
const JOB = (code: number) => ['--', 'bash', '-c', `echo job-ran; exit ${code}`]

describe('relay-checkin', () => {
  test('no key: the job runs as before and curl is never called', () => {
    const r = run(['relay-registry-backup', '40 18 * * *', '30', '30', ...JOB(0)])
    expect(r).toMatchObject({ code: 0, out: 'job-ran\n', calls: [] })
    expect(run(['relay-registry-backup', '40 18 * * *', '30', '30', ...JOB(3)]).code).toBe(3)
  })

  test('with a key: in_progress with the monitor schedule, then ok, to the same URL as checkInUrl', () => {
    const r = run(['relay-registry-backup', '40 18 * * *', '30', '30', ...JOB(0)], { RELAY_SENTRY_DSN: DSN })
    expect(r.code).toBe(0)
    expect(r.out).toBe('job-ran\n')
    expect(r.calls.length).toBe(2)
    const url = checkInUrl(DSN, 'relay-registry-backup')!
    expect(url).toBe('https://o1.ingest.example.test/api/42/cron/relay-registry-backup/0123abcd/')
    const [start, end] = r.calls
    expect(start!.at(-1)).toBe(url)
    expect(start).toContain('--max-time')
    const body = JSON.parse(start![start!.indexOf('--data-binary') + 1]!)
    expect(body).toMatchObject({
      status: 'in_progress', environment: 'production',
      monitor_config: { schedule: { type: 'crontab', value: '40 18 * * *' }, checkin_margin: 30, max_runtime: 30, timezone: 'UTC' },
    })
    expect(body.check_in_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(end!.at(-1)).toBe(`${url}?check_in_id=${body.check_in_id}&status=ok&environment=production`)
    // only the slug, the id, the status, the environment and the schedule: never the job's output
    expect(JSON.stringify(r.calls)).not.toContain('job-ran')
  })

  test('a failed job: error, and its exit code is kept', () => {
    const r = run(['relay-cf-ips-refresh', '17 3 * * 1', '45', '10', ...JOB(7)], { RELAY_SENTRY_DSN: DSN, RELAY_SENTRY_ENV: 'staging' })
    expect(r.code).toBe(7)
    expect(r.calls.at(-1)!.at(-1)).toEndWith('&status=error&environment=staging')
  })

  test('the key from relay.env when the environment has none; an interval schedule', () => {
    const envFile = path.join(tmp, 'relay-file.env')
    fs.writeFileSync(envFile, `RELAY_DOMAIN=example.test\nRELAY_SENTRY_DSN=${DSN}\nRELAY_SENTRY_ENV=\n`)
    const log = path.join(tmp, 'curl-file.log')
    const p = Bun.spawnSync(['bash', SCRIPT, 'relay-litestream', 'every 15 minute', '10', '5', ...JOB(0)], { env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_CURL_LOG: log, RELAY_ENV_FILE: envFile } })
    expect(p.exitCode).toBe(0)
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\0').filter(Boolean))
    const body = JSON.parse(calls[0]![calls[0]!.indexOf('--data-binary') + 1]!)
    expect(body.monitor_config.schedule).toEqual({ type: 'interval', value: 15, unit: 'minute' })
    expect(body.environment).toBe('production')
    expect(calls[0]!.at(-1)).toBe(checkInUrl(DSN, 'relay-litestream')!)
  })

  test('a check-in that cannot be sent never changes the job\'s result', () => {
    const ok = run(['relay-registry-backup', '40 18 * * *', '30', '30', ...JOB(0)], { RELAY_SENTRY_DSN: DSN, FAKE_CURL_EXIT: '28' })
    expect(ok.code).toBe(0)
    expect(ok.out).toBe('job-ran\n')
    expect(ok.err).toContain('check-in was not sent')
    expect(run(['relay-registry-backup', '40 18 * * *', '30', '30', ...JOB(2)], { RELAY_SENTRY_DSN: DSN, FAKE_CURL_EXIT: '6' }).code).toBe(2)
  })

  test('a key that is not a Sentry key: a warning, no curl, the job runs', () => {
    const r = run(['relay-registry-backup', '40 18 * * *', '30', '30', ...JOB(0)], { RELAY_SENTRY_DSN: 'http://nope' })
    expect(r).toMatchObject({ code: 0, calls: [] })
    expect(r.err).toContain('not a Sentry key')
  })

  test('bad arguments: usage, exit 64, the job does not run', () => {
    for (const args of [['Bad Slug', '40 18 * * *', '30', '30', ...JOB(0)], ['ok', '40 18 * * *', 'x', '30', ...JOB(0)], ['ok', 'every 5 weeks', '1', '1', ...JOB(0)], ['ok', '40 18 * * *', '30', '30', 'bash']]) {
      const r = run(args, { RELAY_SENTRY_DSN: DSN })
      expect(r.code).toBe(64)
      expect(r.out).toBe('')
      expect(r.calls).toEqual([])
    }
  })
})

describe('relay deploy files', () => {
  test('the timers run their jobs through relay-checkin with their monitor slugs; setup-host installs it', () => {
    const read = (f: string) => fs.readFileSync(path.join(ROOT, 'relay/deploy', f), 'utf8')
    expect(read('registry-backup.service')).toContain('ExecStart=/usr/local/sbin/relay-checkin relay-registry-backup "40 18 * * *" 30 30 -- /opt/mycel-relay/current/deploy/registry-backup.sh')
    expect(read('registry-backup.timer')).toContain('OnCalendar=*-*-* 18:40:00 UTC')
    expect(read('cf-ips-refresh.service')).toContain('ExecStart=/usr/local/sbin/relay-checkin relay-cf-ips-refresh "17 3 * * 1" 45 10 --')
    expect(read('cf-ips-refresh.timer')).toContain('OnCalendar=Mon *-*-* 03:17:00 UTC')
    expect(read('litestream-check.service')).toContain('relay-checkin relay-litestream "every 15 minute" 10 5 -- /usr/local/sbin/relay-litestream-check')
    expect(read('litestream-check.timer')).toContain('OnUnitActiveSec=15min')
    const setup = read('setup-host.sh')
    for (const s of ['relay-checkin.sh" /usr/local/sbin/relay-checkin', 'litestream-check.sh" /usr/local/sbin/relay-litestream-check', 'litestream-check.timer >/dev/null']) expect(setup).toContain(s)
    expect(read('mycel-relay@.service')).toContain('Environment=RELAY_INSTANCE=%i')
    expect(read('relay.env.example')).toMatch(/^RELAY_SENTRY_DSN=$/m)
    for (const f of ['relay-checkin.sh', 'litestream-check.sh']) {
      expect(fs.statSync(path.join(ROOT, 'relay/deploy', f)).mode & 0o111).not.toBe(0)
      expect(Bun.spawnSync(['bash', '-n', path.join(ROOT, 'relay/deploy', f)]).exitCode).toBe(0)
    }
  })
})

describe('litestream-check', () => {
  const CHECK = path.join(ROOT, 'relay/deploy/litestream-check.sh')
  const node = Bun.which('node')
  const fake = path.join(tmp, 'lsbin')
  fs.mkdirSync(fake)
  fs.writeFileSync(path.join(fake, 'systemctl'), '#!/usr/bin/env bash\nexit "${FAKE_ACTIVE:-0}"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(fake, 'timeout'), '#!/usr/bin/env bash\nshift; exec "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(fake, 'litestream'), '#!/usr/bin/env bash\nprintf "%s" "$FAKE_LTX"; exit "${FAKE_LTX_EXIT:-0}"\n', { mode: 0o755 })
  const db = path.join(tmp, 'registry.db')
  fs.writeFileSync(db, 'x')
  const envFile = path.join(tmp, 'litestream.env')
  fs.writeFileSync(envFile, 'LITESTREAM_ACCESS_KEY_ID=fake\n')
  const at = (s: number) => new Date(s * 1000).toISOString()

  function check(o: { active?: number; ltx?: string; ltxExit?: number; dbChanged: number }) {
    fs.utimesSync(db, o.dbChanged, o.dbChanged)
    const p = Bun.spawnSync(['bash', CHECK], {
      env: {
        PATH: `${fake}:/usr/bin:/bin`, NODE_BIN: node!, RELAY_REGISTRY_DB: db, LITESTREAM_ENV_FILE: envFile,
        FAKE_ACTIVE: String(o.active ?? 0), FAKE_LTX: o.ltx ?? '[]', FAKE_LTX_EXIT: String(o.ltxExit ?? 0),
      },
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  test('ok when the newest replica file is not far behind the registry; an idle registry is fine', () => {
    if (!node) return
    const now = Math.floor(Date.now() / 1000)
    const ltx = JSON.stringify([{ level: 0, timestamp: at(now - 120) }, { level: 1, timestamp: at(now - 3600) }])
    expect(check({ ltx, dbChanged: now - 60 })).toMatchObject({ code: 0 })
    // nothing changed for a day, the replica is a day old: still ok
    expect(check({ ltx: JSON.stringify([{ level: 9, timestamp: at(now - 86_400) }]), dbChanged: now - 86_500 }).code).toBe(0)
  }, 60_000)

  test('error when Litestream is down, the replica cannot be read, is empty, or falls behind the registry', () => {
    if (!node) return
    const now = Math.floor(Date.now() / 1000)
    const fresh = JSON.stringify([{ level: 0, timestamp: at(now - 60) }])
    expect(check({ active: 3, ltx: fresh, dbChanged: now }).err).toContain('litestream is not running')
    const unreadable = check({ ltxExit: 1, ltx: 'AccessDenied', dbChanged: now })
    expect(unreadable.code).toBe(1)
    expect(unreadable.err).toContain('cannot list the replica')
    expect(check({ ltx: 'not json', dbChanged: now }).err).toContain('cannot read the replica file list')
    expect(check({ ltx: '[]', dbChanged: now }).err).toContain('the replica has no files')
    const behind = check({ ltx: JSON.stringify([{ level: 0, timestamp: at(now - 3600) }]), dbChanged: now })
    expect(behind.code).toBe(1)
    expect(behind.err).toContain('Litestream is not uploading')
  }, 60_000)
})
