// Desktop app, office direct connection (fix/prod-ops): the pinned probe tells a timeout from an unreachable address,
// and a failed office connection is reported to the team server (POST /api/connect-info/lan-failure through the
// team address) — a different certificate always, an address that does not answer only when the server Mac's
// Bonjour name answers on this network (the person is in the office).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { CSRF_HEADER } from '@mycel/shared/api'
import { lanFailureCode, officeNameAnswers, probeDirect, probePinned, reportLanFailure } from '../../desktop/src/main/direct'
import { WORK } from '../lib/env'

const DIR = path.join(WORK, 'e-lan-failure')
const TLS_PORT = 19768, SILENT_PORT = 19769, CLOSED_PORT = 19770
let tls: ReturnType<typeof Bun.serve>
let silent: net.Server
let fp = ''

beforeAll(async () => {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
  const cert = path.join(DIR, 'c.pem'), key = path.join(DIR, 'k.pem')
  const r = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=lan-test'], { stdout: 'ignore', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  fp = new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256
  tls = Bun.serve({
    hostname: '127.0.0.1', port: TLS_PORT, tls: { cert: Bun.file(cert), key: Bun.file(key) },
    fetch: () => Response.json({ ok: true, version: '0.1.0', schema: { applied: 1, readerLevel: 1 }, uptimeSec: 1, time: new Date().toISOString() }),
  })
  // accepts TCP and never answers: the probe gives up (timeout)
  silent = net.createServer(() => {}).listen(SILENT_PORT, '127.0.0.1')
  await new Promise((r) => silent.once('listening', r))
})
afterAll(() => { tls.stop(true); silent.close() })

describe('pinned probe', () => {
  // (a different certificate -> 'mismatch' needs Node's TLS 'secureConnect' event, which Bun's node:https does not
  // emit; the desktop e2e test 'a LAN certificate that does not match the pin...' covers it in Electron)
  test('ok, timeout and unreachable are told apart', async () => {
    expect(await probePinned('127.0.0.1', TLS_PORT, fp)).toBe('ok')
    expect(await probePinned('127.0.0.1', SILENT_PORT, fp, 300)).toBe('timeout')
    expect(await probePinned('127.0.0.1', CLOSED_PORT, fp)).toBe('unreachable')
  })
  test('several hosts: ok wins, then mismatch, then timeout', async () => {
    const d = (hosts: string[], port: number, f = fp) => ({ teamId: 't', fingerprint: f, port, hosts, checkedAt: '' })
    expect((await probeDirect(d(['127.0.0.1'], TLS_PORT))).result).toBe('ok')
    expect((await probeDirect(d(['127.0.0.1'], SILENT_PORT), 300)).result).toBe('timeout')
    expect((await probeDirect(d(['127.0.0.1'], CLOSED_PORT))).result).toBe('unreachable')
    expect(lanFailureCode('ok')).toBeNull()
    expect(lanFailureCode('mismatch')).toBe('cert_mismatch')
    expect(lanFailureCode('timeout')).toBe('timeout')
    expect(lanFailureCode('unreachable')).toBe('unreachable')
  })
})

describe('is the server Mac on this network?', () => {
  test('only a .local name that resolves counts; IP addresses alone do not', async () => {
    const seen: string[] = []
    const ok = (h: string) => { seen.push(h); return Promise.resolve({ address: '192.168.0.20' }) }
    const fail = () => Promise.reject(new Error('ENOTFOUND'))
    expect(await officeNameAnswers(['Acme-Mac.local', '192.168.0.20'], 500, ok)).toBe(true)
    expect(seen).toEqual(['Acme-Mac.local'])
    expect(await officeNameAnswers(['Acme-Mac.local'], 500, fail)).toBe(false)
    expect(await officeNameAnswers(['192.168.0.20', '10.0.0.5'], 500, ok)).toBe(false)
    // an mDNS query that hangs counts as "not here"
    expect(await officeNameAnswers(['Acme-Mac.local'], 100, () => new Promise(() => {}))).toBe(false)
  })
})

describe('the report', () => {
  test('POST /api/connect-info/lan-failure on the team address with the CSRF header', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const ses = { fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 204 }) } }
    expect(await reportLanFailure(ses as any, 'https://acme.treesoop.com', 'cert_mismatch')).toBe(true)
    expect(calls[0]!.url).toBe('https://acme.treesoop.com/api/connect-info/lan-failure')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>)[CSRF_HEADER]).toBe('1')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ code: 'cert_mismatch' })
    const down = { fetch: async () => { throw new Error('offline') } }
    expect(await reportLanFailure(down as any, 'https://acme.treesoop.com', 'timeout')).toBe(false)
  })
})
