// Does this release ship the Windows installer? (owner, 2026-11-26; docs/RELEASE-CI.md 11장 "윈도우는 일주일에 한 번";
// docs/decisions/20261126-windows-weekly.md). The Windows app is signed with SSL.com eSigner, and its plan counts every
// signing (3–4 a release: the app exe, the uninstaller, the installer). So the Mac app, the office zip, the Linux
// server and the phone ship with every release, and the Windows installer about once a week. On the other days the
// office feed keeps naming the last Windows build (scripts/release/publish.ts --keep-windows), so Windows users always
// have a working installer and update.
//
//   bun scripts/release/windows-cadence.ts decide --tag <tag> --notes <notes file> --releases <releases.json>
//       [--input tag|yes|no] [--signing <provider>] [--limit <signings a month>]
//
// The rule (decideWindows), worked out from the repository's GitHub Releases only (no other state):
//   - a run again of a tag that already has a GitHub Release does what its first run did (the installer is there, or
//     its body says Windows was skipped): a version's office manifest never changes its Windows app (publish.ts
//     versionManifestAction)
//   - a tag message line `Windows: no` (or the manual run's input no) skips it
//   - signing on, and the signed Windows releases of the last 30 days x SIGNINGS_PER_RELEASE plus this one would pass
//     the monthly limit: a forced release stops here (before anything is built), an automatic one skips Windows
//   - a tag message line `Windows: yes` (or the input yes) ships it: a hotfix for Windows
//   - otherwise it ships when the last release on this channel with the installer (a stable tag: the last stable one;
//     a beta tag: any, a stable release is also the beta channel's) is 7 or more days old (calendar days in Korea), when
//     there is none, or when signing is on and that installer is unsigned (the first signed build goes out at once)
// The line is taken out of the notes file (it becomes the release notes), like `Rollout: all`. Releases that cannot be read
// (the API did not answer) leave Windows out with a warning: they never stop the Mac, server and phone release. Prints windows=true|false
// and windows_last=<tag> (the release whose installer stays on the feed on a skip day) for $GITHUB_OUTPUT; the reason
// goes to stderr as a ::notice:: or ::warning::.
import fs from 'node:fs'
import path from 'node:path'
import { RELEASE_CHANNEL } from '../../shared/src/release-channel'

/** the published Windows installer's name (release.yml build-windows, the website's WIN_ASSET) */
export const WIN_ASSET = /^.+-Setup-.+-win-x64\.exe$/
/** days between two Windows releases */
export const WINDOWS_EVERY_DAYS = 7
/** what one Windows build may sign: the app exe, the uninstaller, the installer, and one retry */
export const SIGNINGS_PER_RELEASE = 4
/** SSL.com eSigner OV tier 1: 20 signings a month (docs/RELEASE-CI.md 11장 "비용") */
export const DEFAULT_MONTHLY_LIMIT = 20
/** the GitHub Release body's line on a release without a new Windows installer (github-release in release.yml) */
export const SKIP_LINE_START = '**Windows:** no new Windows installer in this release'
export const skipLine = (last: string | null) =>
  `${SKIP_LINE_START} (it is published about once a week)${last ? `; the current Windows installer is the one of ${last}` : ''}.`

export type WindowsChoice = 'yes' | 'no'

const LINE = /^[ \t]*windows[ \t]*:[ \t]*(yes|no)[ \t\r]*$/i
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** The `Windows: yes` / `Windows: no` line of the tag message (alone on its line, outside code), taken out of the notes.
 * Any other line that mentions Windows stays in the notes: release notes say "Windows: …" about real changes. */
export function windowsLineOf(notes: string): { windows: WindowsChoice | null; notes: string } {
  const found: WindowsChoice[] = []
  const kept: string[] = []
  let fence: string | null = null
  let dropBlank = false
  for (const line of notes.split('\n')) {
    const f = FENCE.exec(line)
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && !f[2]!.trim()) fence = null
      kept.push(line)
      continue
    }
    if (f && !(f[1]![0] === '`' && f[2]!.includes('`'))) { fence = f[1]!; kept.push(line); continue }
    const m = LINE.exec(line)
    if (m) { found.push(m[1]!.toLowerCase() as WindowsChoice); dropBlank = true; continue }
    if (dropBlank && !line.trim() && (!kept.length || !kept.at(-1)!.trim())) { dropBlank = false; continue }
    dropBlank = false
    kept.push(line)
  }
  if (new Set(found).size > 1) throw new Error('the tag message has both "Windows: yes" and "Windows: no"')
  return { windows: found[0] ?? null, notes: found.length ? kept.join('\n') : notes }
}

/** Does this PE file (its first bytes are enough) carry an Authenticode signature? The certificate table entry
 * (optional header data directory 4) is set only when the file is signed. null: not a PE file we can read. */
export function peSigned(b: Uint8Array): boolean | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null // MZ
  const pe = buf.readUInt32LE(0x3c)
  if (pe + 24 + 2 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null // PE\0\0
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) return null
  const plus = magic === 0x20b
  const countAt = opt + (plus ? 108 : 92)
  const dirs = opt + (plus ? 112 : 96)
  if (dirs + 5 * 8 > buf.length) return null
  if (buf.readUInt32LE(countAt) < 5) return false
  const at = buf.readUInt32LE(dirs + 4 * 8)
  const size = buf.readUInt32LE(dirs + 4 * 8 + 4)
  return at > 0 && size > 0
}

export interface GhRelease {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string | null
  body?: string | null
  assets?: { name: string; browser_download_url?: string }[]
}

export interface WindowsContext {
  tag: string
  /** this tag's channel: a beta tag counts any release, a stable tag only stable ones */
  prerelease: boolean
  /** the tag message's line */
  line: WindowsChoice | null
  /** the manual run's input: '' or 'tag' follows the tag message */
  input?: string
  /** the repository's releases (GET /repos/{repo}/releases) */
  releases: GhRelease[]
  now: Date
  /** WINDOWS_SIGNING_PROVIDER is set */
  signing: boolean
  /** is a release's Windows installer signed (null: could not tell); asked only when signing is on */
  signed?: (r: GhRelease) => boolean | null
  /** signings a month (WINDOWS_SIGNING_MONTHLY_LIMIT) */
  limit?: number
}

export interface WindowsDecision {
  windows: boolean
  /** the newest earlier release with the installer on this channel (the one the feed keeps on a skip day) */
  last: string | null
  reason: string
  /** ::warning:: rather than ::notice:: */
  warn?: boolean
}

const installerOf = (r: GhRelease) => r.assets?.find((a) => typeof a?.name === 'string' && WIN_ASSET.test(a.name))
const publishedAt = (r: GhRelease) => (typeof r.published_at === 'string' ? Date.parse(r.published_at) : NaN)
/** the calendar day in Korea (UTC+9, the owner's day: one release a day) */
const kstDay = (t: number) => Math.floor((t + 9 * 3600_000) / 86_400_000)

/** The newest release on this channel with the Windows installer, not counting `tag` itself. */
export function lastWindowsRelease(releases: GhRelease[], tag: string, prerelease: boolean): GhRelease | null {
  let best: GhRelease | null = null
  for (const r of releases) {
    if (!r || r.draft || r.tag_name === tag || !installerOf(r) || Number.isNaN(publishedAt(r))) continue
    if (!prerelease && r.prerelease) continue
    if (!best || publishedAt(r) > publishedAt(best)) best = r
  }
  return best
}

/** The releases of the 30 days before `now` (any channel) whose Windows installer counts against the signing plan. */
export function signedRecently(c: Pick<WindowsContext, 'releases' | 'tag' | 'now' | 'signed'>): GhRelease[] {
  const from = c.now.getTime() - 30 * 86_400_000
  return c.releases.filter((r) => r && !r.draft && r.tag_name !== c.tag && installerOf(r) && publishedAt(r) > from
    && c.signed?.(r) !== false) // unknown counts: better skip a week than pay past the plan
}

/** See the header. Throws when a forced choice cannot be kept (the release stops before anything is built). */
export function decideWindows(c: WindowsContext): WindowsDecision {
  const input = (c.input ?? '').trim().toLowerCase()
  if (input && input !== 'tag' && input !== 'yes' && input !== 'no') throw new Error(`windows input ${JSON.stringify(c.input)}: tag, yes or no`)
  const forced: WindowsChoice | null = input === 'yes' || input === 'no' ? input : c.line
  const by = input === 'yes' || input === 'no' ? 'the run\'s windows input' : 'the tag message'
  const last = lastWindowsRelease(c.releases, c.tag, c.prerelease)
  const lastTag = last?.tag_name ?? null

  // a run again of a released tag: what its first run did
  const own = c.releases.find((r) => r && !r.draft && r.tag_name === c.tag)
  if (own) {
    const skipped = !installerOf(own) && (own.body ?? '').split('\n').some((l) => l.startsWith(SKIP_LINE_START))
    if (forced && (forced === 'yes') === skipped) {
      throw new Error(`${c.tag} was first published ${skipped ? 'without' : 'with'} the Windows installer; its office manifest keeps that. Tag a new version to change it`)
    }
    return skipped
      ? { windows: false, last: lastTag, reason: `${c.tag} was published without the Windows installer: this run keeps it that way` }
      : { windows: true, last: lastTag, reason: `${c.tag} is a release with the Windows installer: this run builds it` }
  }

  if (forced === 'no') return { windows: false, last: lastTag, reason: `${by} says "Windows: no": no Windows installer in this release` }

  if (c.signing) {
    const limit = c.limit ?? DEFAULT_MONTHLY_LIMIT
    const recent = signedRecently(c)
    const need = (recent.length + 1) * SIGNINGS_PER_RELEASE
    if (need > limit) {
      const why = `${recent.length} signed Windows release(s) in the last 30 days (${recent.map((r) => r.tag_name).join(', ')}) and this one would sign up to ${need} times, over the plan's ${limit} a month (WINDOWS_SIGNING_MONTHLY_LIMIT)`
      if (forced === 'yes') throw new Error(`${by} says "Windows: yes", but ${why}. Tag again without the line, or raise the plan first (docs/RELEASE-CI.md 11장)`)
      return { windows: false, last: lastTag, reason: `${why}: no Windows installer in this release`, warn: true }
    }
  }

  if (forced === 'yes') return { windows: true, last: lastTag, reason: `${by} says "Windows: yes"` }
  if (!last) return { windows: true, last: null, reason: 'no earlier release has the Windows installer' }
  if (c.signing && c.signed?.(last) === false) return { windows: true, last: lastTag, reason: `${lastTag}'s Windows installer is unsigned and signing is on: the first signed one goes out now` }
  const days = kstDay(c.now.getTime()) - kstDay(publishedAt(last))
  if (days >= WINDOWS_EVERY_DAYS) return { windows: true, last: lastTag, reason: `the last Windows installer (${lastTag}) is ${days} days old` }
  return { windows: false, last: lastTag, reason: `the last Windows installer (${lastTag}) is ${days} day(s) old; the next one comes from ${WINDOWS_EVERY_DAYS} days (a "Windows: yes" line in the tag message sends one now)` }
}

/** the installer's first bytes, from the release feed (the same file, published with the release), else GitHub */
export async function fetchSigned(r: GhRelease, o: { fetch?: typeof fetch; feed?: string } = {}): Promise<boolean | null> {
  const a = installerOf(r)
  if (!a) return null
  const version = r.tag_name.replace(/^v/, '')
  const feed = (o.feed ?? RELEASE_CHANNEL.feed).replace(/\/+$/, '')
  const urls = [`${feed}/${RELEASE_CHANNEL.officeDir}/${version}/${a.name}`, ...(a.browser_download_url ? [a.browser_download_url] : [])]
  const f = o.fetch ?? fetch
  for (const url of urls) {
    try {
      const res = await f(url, { headers: { range: 'bytes=0-4095' }, signal: AbortSignal.timeout(20_000) })
      if (res.status !== 200 && res.status !== 206) { await res.body?.cancel(); continue }
      // a server that ignores Range sends the whole file: read only the start
      const reader = res.body!.getReader()
      const parts: Uint8Array[] = []
      let n = 0
      while (n < 4096) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        n += value.length
      }
      await reader.cancel().catch(() => {})
      const got = peSigned(Buffer.concat(parts))
      if (got !== null) return got
    } catch {}
  }
  return null
}

function arg(a: string[], name: string): string | undefined {
  const i = a.indexOf(name)
  return i >= 0 ? a[i + 1] : undefined
}

export async function main(argv: string[], o: { out?: (s: string) => void; err?: (s: string) => void; fetch?: typeof fetch; now?: Date } = {}): Promise<WindowsDecision> {
  const out = o.out ?? ((s: string) => process.stdout.write(s))
  const err = o.err ?? ((s: string) => process.stderr.write(s))
  const [cmd, ...a] = argv
  const tag = arg(a, '--tag'), notesFile = arg(a, '--notes'), releasesFile = arg(a, '--releases')
  if (cmd !== 'decide' || !tag || !notesFile || !releasesFile) {
    throw new Error('usage: windows-cadence.ts decide --tag <tag> --notes <notes file> --releases <releases.json> [--input tag|yes|no] [--signing <provider>] [--limit <n>]')
  }
  const limitArg = arg(a, '--limit')?.trim()
  const limit = limitArg ? Number(limitArg) : DEFAULT_MONTHLY_LIMIT
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit ${limitArg}: a whole number of signings a month`)
  const notesPath = path.resolve(notesFile)
  const parsed = windowsLineOf(fs.readFileSync(notesPath, 'utf8'))
  // the GitHub API did not answer (release.yml tries 3 times): no Windows today, the rest of the release goes on
  let releases: GhRelease[]
  try {
    releases = JSON.parse(fs.readFileSync(path.resolve(releasesFile), 'utf8')) as GhRelease[]
    if (!Array.isArray(releases)) throw new Error('not a list of releases')
  } catch (e) {
    if (parsed.windows) fs.writeFileSync(notesPath, parsed.notes)
    const d: WindowsDecision = { windows: false, last: null, warn: true, reason: `the GitHub Releases could not be read (${releasesFile}: ${(e as Error).message.slice(0, 200)}), so it cannot tell when the last Windows installer went out; the office feed keeps the last one. Run a "Windows: yes" release later if Windows needs this one` }
    err(`::warning::No Windows installer in this release: ${d.reason}\n`)
    out(`windows=false\nwindows_last=\n`)
    return d
  }
  const signing = !!arg(a, '--signing')?.trim()
  const now = o.now ?? new Date()
  // the installers whose signature the rule may ask about: the last one on this channel and those of the last 30 days
  const signed = new Map<string, boolean | null>()
  if (signing) {
    const prerelease = tag.includes('-')
    const ask = new Set([lastWindowsRelease(releases, tag, prerelease), ...signedRecently({ releases, tag, now })].filter((r): r is GhRelease => !!r))
    for (const r of ask) signed.set(r.tag_name, await fetchSigned(r, { fetch: o.fetch }))
  }
  const d = decideWindows({ tag, prerelease: tag.includes('-'), line: parsed.windows, input: arg(a, '--input'), releases, now, signing, signed: (r) => signed.get(r.tag_name) ?? null, limit })
  if (parsed.windows) fs.writeFileSync(notesPath, parsed.notes)
  err(`${d.warn ? '::warning::' : '::notice::'}${d.windows ? `The Windows installer is in this release` : 'No Windows installer in this release'}: ${d.reason}\n`)
  out(`windows=${d.windows}\nwindows_last=${d.last ?? ''}\n`)
  return d
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`windows-cadence: ${(e as Error).message}\n`); process.exit(1) })
}
