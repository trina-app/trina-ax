// Pause a release's roll-out, and resume it (docs/RELEASE-CI.md 6 "잘못된 버전이 나감"): when a bad release is out, one
// command stops it reaching more self-installed servers and offices, without a new version.
//
//   bun scripts/release/hosting.ts hold   <stable|beta> [--reason "…"] [--version X] [--dry-run]
//   bun scripts/release/hosting.ts resume <stable|beta> [--version X] [--dry-run]
//   bun scripts/release/hosting.ts held   <stable|beta>                      what the heads say now (reads only)
//       (tests and a local feed: [--out FEED_DIR --feed https://127.0.0.1:PORT --trust <public key>,…])
//
// It re-signs only the channel's small head files with the release key: server/<channel>.json (+ .sig) and the office
// list <officeDir>/<channel>.json when it is at the same version. It never changes a version's own files
// (server/<version>/release.json, <officeDir>/<version>/<channel>.json), never moves a head to another version and
// never deletes anything. The held head's rollout (server/src/system/rollout.ts holdRollout) is percent 0 with one 0%
// step and `hold: { at, reason }`, so every updater holds: the app's own and the office's (they know `hold` and say
// "Updates are paused"), the root update timer, and older servers that know only `ramp` or only `percent`. A server
// that already runs the release keeps running it (versions never go back). `resume` gives the roll-out back with its
// steps that had not come yet moved by the time it was held (resumeRollout): the ramp goes on where it stopped.
// `changedAt` on both heads lets a reader that saw the newer head refuse an older copy served again (newerHeadSeen).
// A held release is not installed by an administrator's "update now" either (Admin › System, `sudo mycel-ctl update`,
// `teamax update now`): the held head names its own version as minFrom, which also holds the root update timers that do
// not know `hold` (0.4.0-beta.2 and older); resume gives the old minFrom back. Offices of 0.4.0-beta.2 and older have no
// roll-out at all and do not hold (docs/RELEASE-CI.md 6).
//
// A new version published over a held head replaces it as usual (its own new ramp; a fix goes out with `Rollout: all`).
// A re-run of the held version's publish leaves the held head as it is (publish-server.ts, publish.ts).
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReleaseFeed as ProtocolReleaseFeed, releaseChannelPath } from '../../shared/src/cloud-protocol/release'
import { openSignedManifest } from '../../shared/src/release-manifest'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'
import { silentLogger } from '../../server/src/log'
import { OfficeRelease, publicKeyOf, verifyRelease } from '../../server/src/office/release'
import { HeldRollout, holdRollout, readRollout, resumeRollout, rolloutPercent, rampText, type Rollout } from '../../server/src/system/rollout'
import { keyId, ReleaseFeed, UpdateManager } from '../../server/src/system/update'
import { cloudflareStore, dirStore, readHead, type FeedStore } from './publish-server'
import type { Channel } from './release-ci'
import { checkSigningKey, signDetached, verifyDetached } from './sign'

const utf8 = (b: Uint8Array) => Buffer.from(b).toString('utf8')
const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
type Raw = Record<string, unknown> & { rollout?: unknown }

export interface HoldOptions {
  action: 'hold' | 'resume' | 'held'
  channel: Channel
  /** hold: why (the publish log, `mycel-ctl status`, office logs; the Admin pages only say it is paused) */
  reason?: string
  /** the version the head must be at (a guard against holding the wrong release); absent: whatever it is at */
  version?: string
  dryRun?: boolean
  /** https origin of the feed (RELEASE_CHANNEL.feed; a local address for --out) */
  feed: string
  keys: readonly string[]
  /** the private key (PEM); not needed for `held` */
  pem?: string
  store: FeedStore
  officeDir?: string
  now?: () => Date
  log?: (s: string) => void
}

export interface HoldResult {
  status: 'held' | 'resumed' | 'unchanged' | 'dry-run' | 'shown'
  channel: Channel
  version: string
  uploaded: string[]
  /** what each head says after the run */
  server: { held: boolean; percentNow: number }
  office: { version: string; held: boolean } | null
}

/** The roll-out a hold or resume writes, from the head's raw rollout (as the servers read it), and the minFrom resume
 * gives back (hold.minFrom; undefined: not kept, the office list) */
function nextRollout(action: 'hold' | 'resume', raw: unknown, now: Date, reason: string, publishedAt: string | undefined): { rollout: Rollout; minFrom?: string | null } | 'unchanged' {
  const cur = readRollout(raw)
  if (action === 'hold') return cur?.hold ? 'unchanged' : { rollout: holdRollout(cur, now, reason) }
  if (!cur?.hold) return 'unchanged'
  const held = HeldRollout.safeParse(raw)
  if (!held.success) throw new Error(`the held head's rollout cannot be read to resume it (${held.error.issues[0]?.message ?? 'unknown'}): look at it by hand`)
  return { rollout: resumeRollout(held.data, publishedAt, now), minFrom: held.data.hold.minFrom }
}

const describeRollout = (r: Rollout | undefined) => !r ? 'no roll-out (every server at once)'
  : r.hold ? `held since ${r.hold.at}${r.hold.reason ? ` (${r.hold.reason})` : ''}`
  : r.ramp?.length ? `${rampText(r.ramp)}${r.since ? ` from ${r.since}` : ''}` : `${r.percent}%`

export async function holdRelease(o: HoldOptions): Promise<HoldResult> {
  const log = o.log ?? ((s: string) => console.log(s))
  if (o.channel !== 'stable' && o.channel !== 'beta') throw new Error('channel must be stable or beta')
  const feed = o.feed.replace(/\/+$/, '')
  const now = o.now?.() ?? new Date()
  const reason = (o.reason ?? '').trim()
  const officeKey = `${o.officeDir ?? RELEASE_CHANNEL.officeDir}/${o.channel}.json`
  const headKey = releaseChannelPath(o.channel)
  if (o.action !== 'held') checkSigningKey(o.pem ?? '', o.keys)

  // 1. the server head, verified
  const head = await readHead(o.store, o.channel, o.keys)
  if (!head) throw new Error(`${headKey} is not on the feed: nothing to ${o.action}`)
  const version = head.feed.version
  if (o.version && o.version !== version) throw new Error(`${headKey} is at ${version}, not ${o.version}: nothing changed`)
  const raw = JSON.parse(utf8(head.bytes)) as Raw

  // the office list of the same channel, when it is at that version (an office build that did not go out keeps the
  // previous release there: left alone)
  const officeText = await o.store.get(officeKey)
  let office: { text: string; payload: Raw; release: OfficeRelease } | null = null
  if (officeText) {
    const release = verifyRelease(utf8(officeText), { keys: o.keys, channel: o.channel, feed })
    const opened = openSignedManifest(utf8(officeText), o.keys)
    if (!opened.ok) throw new Error(`${officeKey}: ${opened.reason}`) // verifyRelease passed: never expected
    // resume also gives back a held office list at another version (a newer server release went out over it, its office
    // publish did not): it would stay held for good otherwise
    if (release.version === version || (o.action === 'resume' && release.rollout?.hold)) office = { text: utf8(officeText), payload: JSON.parse(opened.payload) as Raw, release }
    else log(`${officeKey} is at ${release.version}, not ${version}: left as it is`)
  } else log(`${officeKey} is not on the feed: only the server head`)

  const serverNow = (f: { rollout?: Rollout; publishedAt?: string; urgent?: boolean }) => ({ held: !!f.rollout?.hold, percentNow: rolloutPercent(f, { now, channel: o.channel }) })
  if (o.action === 'held') {
    log(`${headKey}: ${version}, ${describeRollout(head.feed.rollout)}; ${rolloutPercent(head.feed, { now, channel: o.channel })}% of the ${o.channel} servers take it by themselves now`)
    if (office) log(`${officeKey}: ${office.release.version}, ${describeRollout(office.release.rollout)}`)
    return { status: 'shown', channel: o.channel, version, uploaded: [], server: serverNow(head.feed), office: office ? { version: office.release.version, held: !!office.release.rollout?.hold } : null }
  }

  // 2. the new heads: the same fields, only the rollout changed, signed like a publish
  const ups: { key: string; bytes: Uint8Array | string }[] = []
  const nextServer = nextRollout(o.action, raw.rollout, now, reason, head.feed.publishedAt)
  let serverFeed: ReleaseFeed = head.feed
  if (nextServer === 'unchanged') log(`${headKey}: ${version} is ${o.action === 'hold' ? `already held (since ${head.feed.rollout?.hold?.at})` : 'not held'}: left as it is`)
  else {
    // the server head's minFrom: the held version itself while held (update timers that do not know `hold`, 0.4.0-beta.2
    // and older, refuse a release newer than minFrom; the app ignores minFrom and holds by percent 0), given back on resume
    let next: Raw
    if (o.action === 'hold') {
      const r = nextServer.rollout as HeldRollout
      next = { ...raw, minFrom: version, rollout: { ...r, hold: { ...r.hold, minFrom: typeof raw.minFrom === 'string' ? raw.minFrom : null } } }
    } else {
      if (nextServer.minFrom === undefined) throw new Error(`${headKey}'s hold does not say its minFrom from before: look at it by hand`)
      next = { ...raw, minFrom: nextServer.minFrom, rollout: nextServer.rollout }
    }
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(next, null, 1) + '\n'))
    serverFeed = ReleaseFeed.parse(JSON.parse(utf8(bytes)))
    const proto = ProtocolReleaseFeed.parse(JSON.parse(utf8(bytes)))
    // what the readers make of it: the same release, and the roll-out as written (the hosted cloud ignores rollout)
    if (serverFeed.version !== version || JSON.stringify(serverFeed.bundles) !== JSON.stringify(head.feed.bundles) || proto.version !== version) throw new Error('the new head does not read as the same release') // never expected
    if (o.action === 'hold' && serverFeed.minFrom !== version) throw new Error('the held head does not name its own version as minFrom') // never expected
    const { before: _, ...forServers } = nextServer.rollout as Rollout & { before?: unknown }
    if (JSON.stringify(readRollout(serverFeed.rollout)) !== JSON.stringify(readRollout(forServers))) throw new Error(`the roll-out ${JSON.stringify(nextServer.rollout)} does not read back as written`)
    if (o.action === 'hold') {
      for (const f of [serverFeed, { ...serverFeed, urgent: true }, { ...serverFeed, rollout: serverFeed.rollout && { percent: serverFeed.rollout.percent, salt: serverFeed.rollout.salt, ramp: serverFeed.rollout.ramp } }]) {
        for (const channel of ['stable', 'beta']) if (rolloutPercent(f, { now, channel }) !== 0) throw new Error('the held head would still let servers take the release') // never expected
      }
    }
    const sig = signDetached(bytes, o.pem!)
    if (!verifyDetached(bytes, sig, o.keys)) throw new Error('the signed head does not verify with the trusted keys') // never expected
    ups.push({ key: headKey, bytes }, { key: headKey + '.sig', bytes: sig })
    log(`${headKey}: ${version}, ${describeRollout(head.feed.rollout)} -> ${describeRollout(serverFeed.rollout)}`)
  }

  let officeAfter = office?.release ?? null
  if (office) {
    const next = nextRollout(o.action, office.payload.rollout, now, reason, office.release.publishedAt)
    if (next === 'unchanged') log(`${officeKey}: ${version} is ${o.action === 'hold' ? 'already held' : 'not held'}: left as it is`)
    else {
      // signed over the payload text as written (not through OfficeRelease, which would drop `before`); its minFrom stays
      // (an office of 0.4.0-beta.2 or older, which has no roll-out, does not hold: docs/RELEASE-CI.md 6)
      const payload = JSON.stringify({ ...office.payload, rollout: next.rollout }, null, 1)
      const pubRaw = Buffer.from(publicKeyOf(o.pem!), 'base64')
      const text = JSON.stringify({ format: 1, payload, keyId: keyId(pubRaw), sig: crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(o.pem!)).toString('base64') }, null, 1) + '\n'
      officeAfter = verifyRelease(text, { keys: o.keys, channel: o.channel, feed })
      if (officeAfter.version !== office.release.version || JSON.stringify(officeAfter.office) !== JSON.stringify(office.release.office)) throw new Error('the new office list does not read as the same release') // never expected
      if (o.action === 'hold' && rolloutPercent(officeAfter, { now, channel: o.channel }) !== 0) throw new Error('the held office list would still let offices take the release') // never expected
      ups.push({ key: officeKey, bytes: text })
      log(`${officeKey}: ${version}, ${describeRollout(office.release.rollout)} -> ${describeRollout(officeAfter.rollout)}`)
    }
  }

  const result = (status: HoldResult['status'], uploaded: string[]): HoldResult => ({
    status, channel: o.channel, version, uploaded, server: serverNow(serverFeed), office: officeAfter ? { version: officeAfter.version, held: !!officeAfter.rollout?.hold } : null,
  })
  if (!ups.length) return result('unchanged', [])
  if (o.dryRun) { log(`dry run: would upload ${ups.map((u) => u.key).join(', ')}`); return result('dry-run', []) }

  // 3. up, only if the heads are still what was read (a publish that ran meanwhile wins: run again)
  const again = await o.store.get(headKey)
  if (!same(again, head.bytes)) throw new Error(`${headKey} changed while this ran (a publish?): nothing uploaded, run again`)
  if (office && (await o.store.get(officeKey).then((b) => (b ? utf8(b) : null))) !== office.text) throw new Error(`${officeKey} changed while this ran (a publish?): nothing uploaded, run again`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-hold-'))
  try {
    for (const [i, u] of ups.entries()) {
      const f = path.join(tmp, String(i))
      fs.writeFileSync(f, u.bytes)
      log(`↑ ${u.key}`)
      await o.store.put(u.key, f, 'application/json')
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }

  // 4. read back as an installed server and an office read it
  if (ups.some((u) => u.key === headKey)) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'release-hold-check-'))
    try {
      const um = new UpdateManager({ appDir: null, dataDir: data, version: '0.0.0', channel: o.channel, feedUrl: `${feed}/${headKey}`, log: silentLogger, keys: o.keys, fetch: o.store.fetch })
      const f = await um.checkFeed()
      if (!f || f.version !== version || f.rollout?.changedAt !== serverFeed.rollout?.changedAt) throw new Error(`the feed's ${o.channel} head does not read back as uploaded: look at it (\`hosting.ts held ${o.channel}\`)`)
    } finally { fs.rmSync(data, { recursive: true, force: true }) }
  }
  if (ups.some((u) => u.key === officeKey)) {
    const back = await o.store.get(officeKey)
    const r = back ? verifyRelease(utf8(back), { keys: o.keys, channel: o.channel, feed }) : null
    if (!r || r.version !== office!.release.version || r.rollout?.changedAt !== officeAfter?.rollout?.changedAt) throw new Error(`${officeKey} does not read back as uploaded: look at it`)
  }
  log(o.action === 'hold'
    ? `held: ${version} on ${o.channel}. Servers and offices not on it yet stay where they are; resume with \`bun scripts/release/hosting.ts resume ${o.channel}\``
    : `resumed: ${version} on ${o.channel}, ${describeRollout(serverFeed.rollout)}`)
  return result(o.action === 'hold' ? 'held' : 'resumed', ups.map((u) => u.key))
}

export async function main(argv: string[]): Promise<HoldResult> {
  const [action, channel] = argv
  if (action !== 'hold' && action !== 'resume' && action !== 'held') throw new Error('usage: hosting.ts hold|resume|held stable|beta [--reason "…"] [--version X] [--dry-run]')
  if (channel !== 'stable' && channel !== 'beta') throw new Error('the channel: stable or beta')
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    if (i < 0) return undefined
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
    return v
  }
  const known = new Set(['--reason', '--version', '--dry-run', '--out', '--feed', '--trust'])
  for (const a of argv.slice(2)) if (a.startsWith('--') && !known.has(a)) throw new Error(`unknown option ${a}`)
  const reason = val('--reason')
  if (reason !== undefined && action !== 'hold') throw new Error('--reason is for hold')
  const out = val('--out')
  const feed = val('--feed') ?? RELEASE_CHANNEL.feed
  if (feed !== RELEASE_CHANNEL.feed && (!out || !/^https?:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(feed))) throw new Error('--feed is only for --out with a feed on this computer (https://127.0.0.1:<port>)')
  const trust = val('--trust')
  if (trust && !out) throw new Error('--trust is only for --out (a local test feed)')
  const keys = trust ? trust.split(',').map((s) => s.trim()) : RELEASE_CHANNEL.keys
  const pem = action === 'held' ? undefined : (await import('./keygen')).readReleaseKey()
  return holdRelease({
    action, channel, reason, version: val('--version'), dryRun: argv.includes('--dry-run'), feed, keys, pem,
    store: out ? dirStore(path.resolve(out), feed) : await cloudflareStore(feed),
  })
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { console.error(`hold: ${(e as Error).message}`); process.exit(1) })
}
