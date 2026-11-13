// Pausing a bad release's roll-out (scripts/release/hold.ts, docs/RELEASE-CI.md 6; QA TC-361), and ending a good one's
// ramp early (promote): the feed math (hold,
// resume continuing the ramp, a replayed older head), what the updaters make of a held head (the app's own, servers that
// do not know `hold` or `ramp`), and the script against a feed in a temporary folder signed with a temporary key.
import { afterAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ReleaseFeed as ProtocolReleaseFeed } from '../../shared/src/cloud-protocol/release'
import { silentLogger } from '../../server/src/log'
import { OfficeRelease, signRelease, verifyRelease } from '../../server/src/office/release'
import { DEFAULT_RAMP, holdRollout, inheritRollout, promoteRollout, inRollout, newerHeadSeen, readRollout, resumeRollout, rolloutPercent, rolloutTurn, HeldRollout, type Rollout } from '../../server/src/system/rollout'
import { ReleaseFeed, UpdateManager } from '../../server/src/system/update'
import { autoUpdateDecision, runUpdate } from '../../server/src/system/update-job'
import type { BackupManager } from '../../server/src/system/backup'
import { dirStore, type FeedStore } from '../../scripts/release/publish-server'
import { holdRelease, main, type HoldOptions } from '../../scripts/release/hold'
import { publicKeyOfPem, signDetached } from '../../scripts/release/sign'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'release-hold-'))
afterAll(() => fs.rmSync(T, { recursive: true, force: true }))

const SALT = '3f9a1c7e5b2d4086a1e0c9b8f7d6e5a4'
const PUBLISHED = '2026-11-04T01:00:00.000Z'
const H = 3_600_000
const hours = (h: number) => new Date(Date.parse(PUBLISHED) + h * H)
const ramp = (): Rollout => ({ percent: 100, salt: SALT, ramp: DEFAULT_RAMP.map((s) => ({ ...s })) })
const feedOf = (rollout: Rollout | undefined, o: { urgent?: boolean } = {}) => ({ rollout, publishedAt: PUBLISHED, urgent: o.urgent ?? false })
const pct = (r: Rollout | undefined, at: Date, channel: 'stable' | 'beta' = 'stable', urgent = false) => rolloutPercent(feedOf(r, { urgent }), { now: at, channel })
// installs whose bucket with SALT is known (native/cmd/mycel-ctl/testdata/rollout.json): 3 (first wave), 47 (second), 62 (third)
const FIRST = 'install-4', SECOND = 'install-2', THIRD = 'install-0'

describe('the feed math', () => {
  test('a hold: 0% for everyone whatever the ramp, the channel or urgent; the salt and the roll-out before are kept', () => {
    const held = holdRollout(ramp(), hours(30), 'crashes on start')
    expect(held).toMatchObject({ percent: 0, salt: SALT, ramp: [{ afterHours: 0, percent: 0 }], hold: { at: hours(30).toISOString(), reason: 'crashes on start' }, changedAt: hours(30).toISOString(), before: ramp() })
    expect(HeldRollout.parse(held)).toEqual(held)
    for (const at of [hours(30), hours(48), hours(500)]) {
      for (const channel of ['stable', 'beta'] as const) for (const urgent of [false, true]) expect(pct(held, at, channel, urgent)).toBe(0)
      for (const id of [FIRST, SECOND, THIRD, null]) {
        expect(inRollout(feedOf(held), id, { now: at, channel: 'stable' })).toBe(false)
        expect(rolloutTurn(feedOf(held), id, { now: at, channel: 'stable' })).toEqual({ wait: true, at: null, paused: true })
      }
    }
    // no roll-out before (Rollout: all, a beta release): a new salt, before null
    const none = holdRollout(undefined, hours(1), '')
    expect(none.salt).toMatch(/^[0-9a-f]{32}$/)
    expect(none.before).toBeNull()
    expect(pct(none, hours(1))).toBe(0)
  })
  test('a second hold, or a clock not after the last change, is refused', () => {
    const held = holdRollout(ramp(), hours(30), 'x')
    expect(() => holdRollout(held, hours(31), 'y')).toThrow(/already held/)
    const resumed = resumeRollout(held, PUBLISHED, hours(40))
    expect(() => holdRollout(resumed, hours(40), 'y')).toThrow(/clock/)
    expect(() => resumeRollout(held, PUBLISHED, hours(30))).toThrow(/clock/)
    expect(() => holdRollout(ramp(), hours(1), 'x'.repeat(501))).toThrow(/500/)
  })
  test('resume continues the ramp where it stopped: held at 30 h (50%), resumed at 102 h: still 50%, everyone 72 h later than planned', () => {
    const held = holdRollout(ramp(), hours(30), 'x')
    const r = resumeRollout(held, PUBLISHED, hours(102))
    expect(r).toEqual({ percent: 100, salt: SALT, ramp: [{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 120, percent: 100 }], changedAt: hours(102).toISOString() })
    expect(pct(r, hours(102))).toBe(50)
    expect(inRollout(feedOf(r), SECOND, { now: hours(102), channel: 'stable' })).toBe(true)
    expect(inRollout(feedOf(r), THIRD, { now: hours(102), channel: 'stable' })).toBe(false)
    expect(rolloutTurn(feedOf(r), THIRD, { now: hours(102), channel: 'stable' })).toEqual({ wait: true, at: hours(120) })
    expect(pct(r, new Date(hours(120).getTime() - 1))).toBe(50)
    expect(pct(r, hours(120))).toBe(100)
    // held on day 1 (10%): the 50% step moves too
    const early = resumeRollout(holdRollout(ramp(), hours(2), 'x'), PUBLISHED, hours(12))
    expect(early.ramp).toEqual([{ afterHours: 0, percent: 10 }, { afterHours: 34, percent: 50 }, { afterHours: 58, percent: 100 }])
    expect(pct(early, hours(30))).toBe(10)
    // the servers read it back as written
    expect(readRollout(JSON.parse(JSON.stringify(r)))).toEqual(r)
  })
  test('hold and resume twice: the delays add up; a held release with no roll-out resumes to everyone (percent 100)', () => {
    const once = resumeRollout(holdRollout(ramp(), hours(30), 'a'), PUBLISHED, hours(40)) // +10 h
    const twice = resumeRollout(holdRollout(once, hours(50), 'b'), PUBLISHED, hours(55)) // +5 h
    expect(twice.ramp).toEqual([{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 63, percent: 100 }])
    const none = resumeRollout(holdRollout(undefined, hours(1), ''), PUBLISHED, hours(2))
    expect(none).toEqual({ percent: 100, salt: expect.stringMatching(/^[0-9a-f]{32}$/), changedAt: hours(2).toISOString() })
    for (const id of [FIRST, THIRD, null]) expect(inRollout(feedOf(none), id, { now: hours(2), channel: 'stable' })).toBe(true)
    // a ramp that had ended when it was held: nothing moves
    expect(resumeRollout(holdRollout(ramp(), hours(60), ''), PUBLISHED, hours(90)).ramp).toEqual([...DEFAULT_RAMP])
    // a burst's start (since) counts as the ramp's start
    const since = { ...ramp(), since: hours(-24).toISOString() }
    expect(resumeRollout(holdRollout(since, hours(10), ''), PUBLISHED, hours(20)).ramp).toEqual([{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 58, percent: 100 }])
  })
  test('a release published over a held head starts its own ramp (nothing is inherited from the bad one)', () => {
    const held = { ...feedOf(holdRollout(ramp(), hours(5), 'x')), urgent: false }
    const next = inheritRollout({ ...ramp(), salt: 'b'.repeat(32) }, held, hours(6).toISOString())
    expect(next).toEqual({ ...ramp(), salt: 'b'.repeat(32) })
  })
  test('a replayed older head: one of the same version changed earlier (or never) is older; another version never is', () => {
    const held = holdRollout(ramp(), hours(30), 'x')
    const resumed = resumeRollout(held, PUBLISHED, hours(40))
    const v = (rollout?: Rollout, version = '1.1.0') => ({ version, rollout })
    expect(newerHeadSeen(v(held), v(ramp()))).toBe(true) // the original served again after a hold
    expect(newerHeadSeen(v(resumed), v(held))).toBe(true) // the hold served again after the resume
    expect(newerHeadSeen(v(held), v(resumed))).toBe(false)
    expect(newerHeadSeen(v(held), v(held))).toBe(false)
    expect(newerHeadSeen(v(held), v(ramp(), '1.2.0'))).toBe(false)
    expect(newerHeadSeen(null, v(ramp()))).toBe(false)
    expect(newerHeadSeen(v(ramp()), v(ramp()))).toBe(false)
  })
})

describe('what the updaters make of a held head', () => {
  const base = { version: '1.1.0', minFrom: null, urgent: false, needsRoot: false, notes: '', publishedAt: PUBLISHED, bundles: [] }
  const held = holdRollout(ramp(), hours(30), 'crashes on start')
  const text = JSON.stringify({ ...base, rollout: held, minReaderRequired: 3 })

  test('the app: paused, nothing installed, whatever the turn; a server already on the release keeps it', () => {
    const f = ReleaseFeed.parse(JSON.parse(text))
    expect(f.rollout?.hold).toEqual({ at: hours(30).toISOString(), reason: 'crashes on start' })
    expect('before' in f.rollout!).toBe(false)
    const o = { tz: 'UTC', window: '00:00-23:59', running: 0, history: [], channel: 'stable' as const }
    for (const id of [FIRST, SECOND, THIRD]) {
      for (const at of [hours(30), hours(200)]) expect(autoUpdateDecision({ ...o, feed: f, current: '1.0.0', installId: id, now: at })).toEqual({ go: false, why: 'paused' })
      expect(autoUpdateDecision({ ...o, feed: f, current: '1.0.0', installId: id, now: hours(200), channel: 'beta' })).toEqual({ go: false, why: 'paused' })
    }
    expect(autoUpdateDecision({ ...o, feed: f, current: '1.1.0', installId: FIRST, now: hours(31) })).toEqual({ go: false, why: 'up_to_date' })
    expect(autoUpdateDecision({ ...o, feed: { ...f, rollout: resumeRollout(held, PUBLISHED, hours(31)) }, current: '1.0.0', installId: FIRST, now: hours(31) })).toEqual({ go: true, version: '1.1.0' })
    expect(ProtocolReleaseFeed.safeParse(JSON.parse(text)).success).toBe(true)
  })
  test('"update now" (Admin › System) does not install a held release either; a resumed one it does', async () => {
    const did: string[] = []
    let f = ReleaseFeed.parse(JSON.parse(text))
    const updates = {
      checkFeed: async () => f, needsRoot: () => false,
      download: async () => { did.push('download') }, switchTo: async (v: string) => { did.push(`switch ${v}`); return { from: '1.0.0', to: v } },
    } as unknown as UpdateManager
    const backups = { run: async () => { did.push('backup') } } as unknown as BackupManager
    const d = { updates, backups, running: () => 0, restart: () => did.push('restart'), locale: 'en' as const, sleep: async () => {} }
    await expect(runUpdate(d, '1.1.0', { staged: false, rollback: false })).rejects.toThrow(/the publisher paused version 1\.1\.0/)
    expect(did).toEqual(['backup'])
    f = { ...f, rollout: resumeRollout(held, PUBLISHED, hours(31)) }
    await runUpdate(d, '1.1.0', { staged: false, rollback: false })
    expect(did).toEqual(['backup', 'backup', 'download', 'switch 1.1.0', 'restart'])
  })
  test('servers that know ramp but not hold (0.4.0-beta.3 to this change), and those that know only percent: 0%', () => {
    // as the earlier zod schema reads it: hold and changedAt dropped
    const noHold = z.object({ percent: z.number(), salt: z.string(), ramp: z.array(z.object({ afterHours: z.number(), percent: z.number() })).optional() }).parse(JSON.parse(text).rollout)
    for (const at of [hours(30), hours(48), hours(500)]) for (const channel of ['stable', 'beta'] as const) {
      expect(pct(noHold, at, channel)).toBe(0)
      expect(pct(noHold, at, channel, true)).toBe(0)
    }
    expect(rolloutTurn(feedOf(noHold), THIRD, { now: hours(30), channel: 'stable' })).toEqual({ wait: true, at: null })
    // 0.4.0-beta.2 and older: percent alone (tests/unit/g-rollout.test.ts "older servers")
    const old = z.object({ percent: z.number().min(0).max(100), salt: z.string().max(100) }).parse(JSON.parse(text).rollout)
    for (let i = 0; i < 300; i++) expect(crypto.createHash('sha256').update(old.salt + `install-${i}`).digest().readUInt16BE(0) % 100 < old.percent).toBe(false)
  })
  test('the office list reads the hold too; offices that know only the ramp hold as well', () => {
    const r = OfficeRelease.shape.rollout.parse(held)
    expect(r?.hold?.reason).toBe('crashes on start')
    expect(rolloutTurn({ rollout: r, publishedAt: PUBLISHED }, THIRD, { now: hours(40), channel: 'stable' })).toEqual({ wait: true, at: null, paused: true })
  })
})

describe('UpdateManager.checkFeed: an older copy of the head served again does not lift a hold', () => {
  const pem = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const keys = [publicKeyOfPem(pem)]
  const URL_ = 'https://releases.test/server/stable.json'
  let body = ''
  const serve = (r: Rollout | undefined, version = '1.1.0') => { body = JSON.stringify({ version, publishedAt: PUBLISHED, bundles: [], ...(r ? { rollout: r } : {}) }) }
  const fetchFake = (async (u: string) => new Response(u.endsWith('.sig') ? signDetached(new Uint8Array(Buffer.from(body)), pem) : body)) as unknown as typeof fetch
  const mgr = (dataDir: string, feedUrl = URL_) => new UpdateManager({ appDir: null, dataDir, version: '1.0.0', channel: 'stable', feedUrl, log: silentLogger, keys, fetch: fetchFake })

  test('held, then the original again: not taken; resumed; the hold again: not taken; a newer version: taken', async () => {
    const data = path.join(T, 'mgr')
    const held = holdRollout(ramp(), hours(30), 'x')
    const resumed = resumeRollout(held, PUBLISHED, hours(40))
    serve(ramp())
    expect((await mgr(data).checkFeed())?.rollout?.hold).toBeUndefined()
    serve(held)
    expect((await mgr(data).checkFeed())?.rollout?.hold?.reason).toBe('x')
    serve(ramp()) // the bytes from before the hold, validly signed
    expect(await mgr(data).checkFeed()).toBeNull()
    expect(mgr(data).lastFeed()?.rollout?.hold?.reason).toBe('x') // the last verified head stands
    serve(resumed)
    expect((await mgr(data).checkFeed())?.rollout).toEqual(resumed)
    serve(held)
    expect(await mgr(data).checkFeed()).toBeNull()
    expect(mgr(data).lastFeed()?.rollout).toEqual(resumed)
    serve(ramp(), '1.2.0')
    expect((await mgr(data).checkFeed())?.version).toBe('1.2.0')
  })
  test('two replays in a row (an older version\'s head, then the copy from before the hold) do not lift it either', async () => {
    const data = path.join(T, 'mgr2')
    serve(holdRollout(ramp(), hours(30), 'x'))
    expect((await mgr(data).checkFeed())?.rollout?.hold).toBeDefined()
    serve(ramp(), '1.0.5')
    expect((await mgr(data).checkFeed())?.version).toBe('1.0.5')
    serve(ramp())
    expect(await mgr(data).checkFeed()).toBeNull()
    expect(autoUpdateDecision({ feed: mgr(data).lastFeed(), current: '1.0.0', installId: FIRST, now: hours(60), tz: 'UTC', window: '00:00-23:59', running: 0, history: [], channel: 'stable' }).go).toBe(true) // 1.0.5, not 1.1.0
    expect(mgr(data).lastFeed()?.version).toBe('1.0.5')
    // another feed address (a channel switch) is not compared with this one's record
    expect((await mgr(data, 'https://releases.test/server/beta.json').checkFeed())?.rollout?.hold).toBeUndefined()
  })

})

// ---------------- the script, on a feed in a folder ----------------

const FEED = 'https://127.0.0.1:45998'
const newPem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const PEM = newPem()
const PUB = publicKeyOfPem(PEM)
const sha = (b: string) => crypto.createHash('sha256').update(b).digest('hex')

/** A feed folder with version 1.1.0 published to stable the way publish-server.ts and publish.ts leave it. */
function publishedFeed(name: string, o: { rollout?: Rollout | null; office?: boolean | string; minFrom?: string } = {}) {
  const root = path.join(T, name)
  fs.rmSync(root, { recursive: true, force: true })
  const put = (k: string, b: string | Uint8Array) => { fs.mkdirSync(path.dirname(path.join(root, k)), { recursive: true }); fs.writeFileSync(path.join(root, k), b) }
  const rollout = o.rollout === null ? undefined : o.rollout ?? ramp()
  const rel = JSON.stringify({ version: '1.1.0', minFrom: o.minFrom ?? null, urgent: false, needsRoot: true, rootSince: '1.1.0', notes: 'n', publishedAt: PUBLISHED,
    bundles: [{ os: 'linux', arch: 'amd64', url: `${FEED}/server/1.1.0/1.1.0-linux-amd64.tar.zst`, sha256: 'a'.repeat(64), size: 10 }], minReaderRequired: 4, ...(rollout ? { rollout } : {}) }, null, 1) + '\n'
  const sig = signDetached(new Uint8Array(Buffer.from(rel)), PEM)
  for (const k of ['server/1.1.0/release.json', 'server/stable.json']) { put(k, rel); put(k + '.sig', sig) }
  put('server/1.1.0/1.1.0-linux-amd64.tar.zst', 'bundle!!!!')
  if (o.office !== false) {
    const version = typeof o.office === 'string' ? o.office : '1.1.0'
    const zip = 'zip'
    const list = signRelease({ format: 1, product: OfficeRelease.shape.product.value, channel: 'stable', version, minFrom: '0.2.0-0', publishedAt: PUBLISHED, notes: '',
      office: [{ arch: 'universal', file: 'x.zip', url: `${FEED}/office/${version}/x.zip`, sha256: sha(zip), size: zip.length }], windows: null, ...(rollout ? { rollout } : {}) }, PEM)
    put('office/stable.json', list)
    put(`office/${version}/stable.json`, list)
  }
  return root
}

/** every file of a folder with its sha256 */
const snapshot = (root: string) => Object.fromEntries((fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => fs.statSync(path.join(root, f)).isFile()).sort().map((f) => [f, sha(fs.readFileSync(path.join(root, f), 'utf8'))]))
const run = (root: string, over: Partial<HoldOptions>) => {
  const lines: string[] = []
  return holdRelease({ action: 'hold', channel: 'stable', feed: FEED, keys: [PUB], pem: PEM, store: dirStore(root, FEED), now: () => hours(30), log: (s) => lines.push(s), ...over }).then((r) => ({ ...r, lines }))
}
const serverSees = async (root: string, now: Date, installId = THIRD) => {
  const um = new UpdateManager({ appDir: null, dataDir: path.join(root, '..', `${path.basename(root)}-data`), version: '1.0.0', channel: 'stable', feedUrl: `${FEED}/server/stable.json`, log: silentLogger, keys: [PUB], fetch: dirStore(root, FEED).fetch })
  const f = await um.checkFeed()
  return { feed: f, decision: autoUpdateDecision({ feed: f, current: '1.0.0', installId, now, tz: 'UTC', window: '00:00-23:59', running: 0, history: [], channel: 'stable', rootVersion: '1.1.0' }) }
}

describe('hosting.ts hold / resume (scripts/release/hold.ts) on a local feed', () => {
  test('hold re-signs only the two heads; servers and offices not on the release stay; the version files are untouched', async () => {
    const root = publishedFeed('hold')
    const before = snapshot(root)
    expect((await serverSees(root, hours(60))).decision).toEqual({ go: true, version: '1.1.0' }) // without the hold: everyone by 48 h
    const r = await run(root, { reason: 'crashes on start' })
    expect(r).toMatchObject({ status: 'held', version: '1.1.0', uploaded: ['server/stable.json', 'server/stable.json.sig', 'office/stable.json'], server: { held: true, percentNow: 0 }, office: { version: '1.1.0', held: true } })
    const after = snapshot(root)
    const changed = Object.keys(after).filter((k) => after[k] !== before[k])
    expect(changed.sort()).toEqual(['office/stable.json', 'server/stable.json', 'server/stable.json.sig'])
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort()) // nothing added, nothing deleted
    // the head: the same release, every field kept but the rollout and minFrom (its own version: update timers that do
    // not know hold refuse it)
    const head = JSON.parse(fs.readFileSync(path.join(root, 'server/stable.json'), 'utf8'))
    const rel = JSON.parse(fs.readFileSync(path.join(root, 'server/1.1.0/release.json'), 'utf8'))
    expect({ ...head, rollout: undefined, minFrom: undefined }).toEqual({ ...rel, rollout: undefined, minFrom: undefined })
    expect(head.minFrom).toBe('1.1.0')
    expect(head.rollout).toEqual({ percent: 0, salt: SALT, ramp: [{ afterHours: 0, percent: 0 }], hold: { at: hours(30).toISOString(), reason: 'crashes on start', minFrom: null }, changedAt: hours(30).toISOString(), before: ramp() })
    // an installed server: paused, at any time
    for (const id of [FIRST, SECOND, THIRD]) expect((await serverSees(root, hours(200), id)).decision).toEqual({ go: false, why: 'paused' })
    // the office list: signed, the same files, held
    const office = verifyRelease(fs.readFileSync(path.join(root, 'office/stable.json'), 'utf8'), { keys: [PUB], channel: 'stable', feed: FEED })
    expect(office.rollout?.hold?.reason).toBe('crashes on start')
    expect(rolloutTurn(office, THIRD, { now: hours(200), channel: 'stable' })).toEqual({ wait: true, at: null, paused: true })
    // again: nothing to do
    const again = await run(root, { reason: 'again', now: () => hours(31) })
    expect(again).toMatchObject({ status: 'unchanged', uploaded: [] })
    expect(snapshot(root)).toEqual(after)
    // what the heads say (reads only, no key)
    const shown = await run(root, { action: 'held', pem: undefined, now: () => hours(31) })
    expect(shown).toMatchObject({ status: 'shown', server: { held: true, percentNow: 0 }, office: { held: true } })
    expect(shown.lines.join('\n')).toContain('held since')
  })

  test('resume: the ramp goes on where it stopped (50% at the hold, the 100% step 72 h later); servers already in take it', async () => {
    const root = publishedFeed('resume')
    await run(root, { reason: 'x' })
    const r = await run(root, { action: 'resume', now: () => hours(102) })
    expect(r).toMatchObject({ status: 'resumed', uploaded: ['server/stable.json', 'server/stable.json.sig', 'office/stable.json'], server: { held: false, percentNow: 50 }, office: { held: false } })
    const head = JSON.parse(fs.readFileSync(path.join(root, 'server/stable.json'), 'utf8'))
    expect(head.rollout).toEqual({ percent: 100, salt: SALT, ramp: [{ afterHours: 0, percent: 10 }, { afterHours: 24, percent: 50 }, { afterHours: 120, percent: 100 }], changedAt: hours(102).toISOString() })
    expect(head.minFrom).toBeNull() // as first published
    const rel = JSON.parse(fs.readFileSync(path.join(root, 'server/1.1.0/release.json'), 'utf8'))
    expect({ ...head, rollout: undefined }).toEqual({ ...rel, rollout: undefined })
    expect((await serverSees(root, hours(102), SECOND)).decision).toEqual({ go: true, version: '1.1.0' })
    expect((await serverSees(root, hours(102), THIRD)).decision).toEqual({ go: false, why: 'rollout' })
    expect((await serverSees(root, hours(120), THIRD)).decision).toEqual({ go: true, version: '1.1.0' })
    const office = verifyRelease(fs.readFileSync(path.join(root, 'office/stable.json'), 'utf8'), { keys: [PUB], channel: 'stable', feed: FEED })
    expect(office.rollout).toEqual(head.rollout)
    expect(await run(root, { action: 'resume', now: () => hours(103) })).toMatchObject({ status: 'unchanged' })
  })

  test('a release published without a roll-out (Rollout: all) holds too and resumes to everyone; its minFrom comes back', async () => {
    const root = publishedFeed('all', { rollout: null, minFrom: '0.9.0' })
    expect((await serverSees(root, hours(0))).decision).toEqual({ go: true, version: '1.1.0' })
    await run(root, { reason: 'x' })
    expect((await serverSees(root, hours(1))).decision).toEqual({ go: false, why: 'paused' })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'server/stable.json'), 'utf8')).minFrom).toBe('1.1.0')
    await run(root, { action: 'resume', now: () => hours(40) })
    expect((await serverSees(root, hours(40))).decision).toEqual({ go: true, version: '1.1.0' })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'server/stable.json'), 'utf8')).minFrom).toBe('0.9.0')
  })

  test('the office list at another version is left alone; --version guards the release; --dry-run uploads nothing', async () => {
    const root = publishedFeed('office-other', { office: '1.0.5' })
    const before = snapshot(root)
    await expect(run(root, { version: '1.0.9' })).rejects.toThrow(/at 1\.1\.0, not 1\.0\.9/)
    const dry = await run(root, { dryRun: true })
    expect(dry).toMatchObject({ status: 'dry-run', uploaded: [] })
    expect(dry.lines.join('\n')).toContain('dry run: would upload server/stable.json, server/stable.json.sig')
    expect(dry.lines.join('\n')).toContain('office/stable.json is at 1.0.5, not 1.1.0: left as it is')
    expect(snapshot(root)).toEqual(before)
    const r = await run(root, { version: '1.1.0' })
    expect(r).toMatchObject({ status: 'held', uploaded: ['server/stable.json', 'server/stable.json.sig'], office: null })
  })

  test('resume gives back an office list still held at the version before a newer server release went out', async () => {
    const root = publishedFeed('office-left-held')
    await run(root, { reason: 'x' })
    // 1.1.1 goes out to the servers; its office publish did not
    const rel = JSON.parse(fs.readFileSync(path.join(root, 'server/1.1.0/release.json'), 'utf8'))
    const next = JSON.stringify({ ...rel, version: '1.1.1', rollout: undefined }, null, 1) + '\n'
    fs.writeFileSync(path.join(root, 'server/stable.json'), next)
    fs.writeFileSync(path.join(root, 'server/stable.json.sig'), signDetached(new Uint8Array(Buffer.from(next)), PEM))
    // not without being asked: a resume meant for the server head never frees another release
    const plain = await run(root, { action: 'resume', now: () => hours(40) })
    expect(plain).toMatchObject({ status: 'unchanged', uploaded: [] })
    expect(plain.lines.join('\n')).toContain('--office-version 1.1.0')
    const r = await run(root, { action: 'resume', officeVersion: '1.1.0', now: () => hours(40) })
    expect(r).toMatchObject({ status: 'resumed', version: '1.1.1', uploaded: ['office/stable.json'], office: { version: '1.1.0', held: false } })
  })

  test('refused: a key the feed does not trust, a head that does not verify, a head that changed while it ran', async () => {
    const root = publishedFeed('refused')
    const before = snapshot(root)
    await expect(run(root, { pem: newPem() })).rejects.toThrow()
    fs.writeFileSync(path.join(root, 'server/stable.json.sig'), signDetached(new Uint8Array(Buffer.from('other')), PEM))
    fs.writeFileSync(path.join(root, 'server/1.1.0/release.json.sig'), signDetached(new Uint8Array(Buffer.from('other')), PEM))
    await expect(run(root, {})).rejects.toThrow(/does not verify/)
    const ok = publishedFeed('refused')
    expect(snapshot(ok)).toEqual(before)
    // a publish in between: the second read of the head differs
    const store = dirStore(ok, FEED)
    let reads = 0
    const racing: FeedStore = { ...store, async get(k) { if (k === 'server/stable.json' && ++reads === 2) return new Uint8Array(Buffer.from('{}')); return store.get(k) } }
    await expect(run(ok, { store: racing })).rejects.toThrow(/changed while this ran/)
    expect(snapshot(ok)).toEqual(before)
  })

  test('a held head that cannot be read to resume is left for a person; the command line checks its options', async () => {
    const root = publishedFeed('unreadable')
    const rel = JSON.parse(fs.readFileSync(path.join(root, 'server/stable.json'), 'utf8'))
    const text = JSON.stringify({ ...rel, rollout: { percent: 0, salt: SALT, hold: { at: hours(1).toISOString() } } }) // held by hand: no before
    fs.writeFileSync(path.join(root, 'server/stable.json'), text)
    fs.writeFileSync(path.join(root, 'server/stable.json.sig'), signDetached(new Uint8Array(Buffer.from(text)), PEM))
    await expect(run(root, { action: 'resume', now: () => hours(5) })).rejects.toThrow(/cannot be read to resume/)
    await expect(main(['pause', 'stable'])).rejects.toThrow(/usage/)
    await expect(main(['hold', 'nightly'])).rejects.toThrow(/stable or beta/)
    await expect(main(['hold', 'stable', '--feed', 'https://evil.example'])).rejects.toThrow(/only for --out/)
    await expect(main(['hold', 'stable', '--trust', PUB])).rejects.toThrow(/only for --out/)
    await expect(main(['resume', 'stable', '--reason', 'x'])).rejects.toThrow(/--reason is for hold/)
    await expect(main(['hold', 'stable', '--force'])).rejects.toThrow(/unknown option/)
    await expect(main(['hold', 'stable', '--office-version', '1.0.0'])).rejects.toThrow(/--office-version is for resume/)
  })
})

// ---------------- promote: a good release to everyone now (ends the ramp) ----------------

describe('promote (hosting.ts promote, the Feed workflow)', () => {
  test('the math: percent 100, no ramp, the salt kept, changedAt; everyone on every channel and for older readers', () => {
    const r = promoteRollout(ramp(), hours(2))
    expect(r).toEqual({ percent: 100, salt: SALT, changedAt: hours(2).toISOString() })
    if (r === 'unchanged') throw new Error('expected a rollout')
    for (const ch of ['stable', 'beta'] as const) for (const urgent of [false, true]) expect(pct(r, hours(2), ch, urgent)).toBe(100)
    for (const id of [FIRST, SECOND, THIRD, null]) expect(inRollout(feedOf(r), id, { now: hours(2), channel: 'stable' })).toBe(true)
    // a reader that saw the ramped head takes the promoted one (later changedAt), not the other way round
    expect(newerHeadSeen({ version: '1.1.0', rollout: ramp() }, { version: '1.1.0', rollout: r })).toBe(false)
    expect(newerHeadSeen({ version: '1.1.0', rollout: r }, { version: '1.1.0', rollout: ramp() })).toBe(true)
    // already everyone: unchanged; a held head: refused (resume first); a clock not after the last change: refused
    expect(promoteRollout(undefined, hours(2))).toBe('unchanged')
    expect(promoteRollout(r, hours(3))).toBe('unchanged')
    expect(promoteRollout({ percent: 40, salt: SALT }, hours(3))).toEqual({ percent: 100, salt: SALT, changedAt: hours(3).toISOString() })
    expect(() => promoteRollout(holdRollout(ramp(), hours(5), 'bad'), hours(6))).toThrow(/held .*resume it first/)
    expect(() => promoteRollout({ ...ramp(), changedAt: hours(10).toISOString() }, hours(9))).toThrow(/clock/)
  })

  test('on a local feed: both heads to everyone at once, the version files and minFrom untouched; a server in the last wave takes it', async () => {
    const root = publishedFeed('promote', { minFrom: '0.9.0' })
    const before = snapshot(root)
    expect((await serverSees(root, hours(2), THIRD)).decision).toEqual({ go: false, why: 'rollout' }) // 10% on day one
    const dry = await run(root, { action: 'promote', version: '1.1.0', dryRun: true, now: () => hours(2) })
    expect(dry).toMatchObject({ status: 'dry-run', uploaded: [] })
    expect(snapshot(root)).toEqual(before)
    const r = await run(root, { action: 'promote', version: '1.1.0', now: () => hours(2) })
    expect(r).toMatchObject({ status: 'promoted', uploaded: ['server/stable.json', 'server/stable.json.sig', 'office/stable.json'], server: { held: false, percentNow: 100 }, office: { version: '1.1.0', held: false } })
    const after = snapshot(root)
    expect(Object.keys(after).filter((k) => after[k] !== before[k]).sort()).toEqual(['office/stable.json', 'server/stable.json', 'server/stable.json.sig'])
    const head = JSON.parse(fs.readFileSync(path.join(root, 'server/stable.json'), 'utf8'))
    const rel = JSON.parse(fs.readFileSync(path.join(root, 'server/1.1.0/release.json'), 'utf8'))
    expect({ ...head, rollout: undefined }).toEqual({ ...rel, rollout: undefined })
    expect(head.minFrom).toBe('0.9.0')
    expect(head.rollout).toEqual({ percent: 100, salt: SALT, changedAt: hours(2).toISOString() })
    for (const id of [FIRST, SECOND, THIRD]) expect((await serverSees(root, hours(2), id)).decision).toEqual({ go: true, version: '1.1.0' })
    const office = verifyRelease(fs.readFileSync(path.join(root, 'office/stable.json'), 'utf8'), { keys: [PUB], channel: 'stable', feed: FEED })
    expect(office.rollout).toEqual(head.rollout)
    expect(inRollout(office, THIRD, { now: hours(2), channel: 'stable' })).toBe(true)
    // again: nothing to do
    expect(await run(root, { action: 'promote', version: '1.1.0', now: () => hours(3) })).toMatchObject({ status: 'unchanged', uploaded: [] })
    expect(snapshot(root)).toEqual(after)
  })

  test('refused: a held head (resume first), another version; an office list at another version is left alone', async () => {
    const held = publishedFeed('promote-held')
    await run(held, { reason: 'bad' })
    const snap = snapshot(held)
    await expect(run(held, { action: 'promote', now: () => hours(40) })).rejects.toThrow(/resume it first/)
    expect(snapshot(held)).toEqual(snap)
    const other = publishedFeed('promote-other', { office: '1.0.5' })
    await expect(run(other, { action: 'promote', version: '1.0.9', now: () => hours(2) })).rejects.toThrow(/at 1\.1\.0, not 1\.0\.9/)
    const r = await run(other, { action: 'promote', version: '1.1.0', now: () => hours(2) })
    expect(r).toMatchObject({ status: 'promoted', uploaded: ['server/stable.json', 'server/stable.json.sig'], office: null })
    expect(r.lines.join('\n')).toContain('office/stable.json is at 1.0.5, not 1.1.0: left as it is')
    await expect(main(['promote', 'stable', '--reason', 'x'])).rejects.toThrow(/--reason is for hold/)
  })

  test('the Feed workflow: only from main, the release group, the key only where it is used, the inputs as env (not in the script)', () => {
    const wf = fs.readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/feed.yml'), 'utf8')
    const rel = fs.readFileSync(path.resolve(import.meta.dir, '../../.github/workflows/release.yml'), 'utf8')
    expect(wf).toContain("if: github.ref == 'refs/heads/main'")
    // the changes wait for (and never run beside) a release publish; held (reads only) has its own group
    expect(/concurrency:\n\s+group: (.+)/.exec(rel)?.[1]).toBe('release-${{ github.repository }}')
    expect(/concurrency:\n\s+group: (.+)/.exec(wf)?.[1]).toBe("${{ inputs.action == 'held' && 'feed-read' || format('release-{0}', github.repository) }}")
    expect(wf.match(/secrets\.RELEASE_SIGNING_KEY/g)?.length).toBe(1)
    expect(wf).toContain('rm -f "$RUNNER_TEMP/release-key.pem"')
    // inputs reach the shell only through env (no ${{ inputs.* }} inside a run: script)
    for (const block of wf.split(/\n\s+run: \|?/).slice(1)) expect(block.split(/\n\s+- (?:name|uses):/)[0]).not.toMatch(/\$\{\{\s*inputs\./)
    for (const a of ['held', 'promote', 'hold', 'resume']) expect(wf).toContain(a)
  })
})
