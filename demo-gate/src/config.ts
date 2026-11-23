// Gate configuration: ONE JSON file (`--config <file>` or DEMO_GATE_CONFIG). Relative paths are resolved against the
// file's folder. Secrets are never in it: the Turnstile secret and the AI credential are paths to 0600 files.
import fs from 'node:fs'
import path from 'node:path'

/** ONE setting picks how the real credential goes upstream (the plan: an API key may replace the subscription later). */
export type AiMode = 'claude-subscription' | 'anthropic-api-key'
export const AI_MODES: readonly AiMode[] = ['claude-subscription', 'anthropic-api-key']
/** every language the gate's pages speak and a snapshot can be in (scripts/demo/steepling/make.ts STEEPLING_LOCALES);
 * `pool.locales` picks the live ones (default en and ko) */
export type Locale = 'en' | 'ko' | 'ja' | 'zh' | 'es' | 'id'
export const LOCALES: readonly Locale[] = ['en', 'ko', 'ja', 'zh', 'es', 'id']
export const isLocale = (x: unknown): x is Locale => typeof x === 'string' && (LOCALES as readonly string[]).includes(x)

export interface GateConfig {
  /** the visitors' address, e.g. https://demo.trina.app: the instances' only public origin, the persona call's Origin */
  publicOrigin: string
  /** the public listener (cloudflared delivers demo.trina.app here) */
  listen: { host: string; port: number }
  /** the model upstream the instances call (loopback only) */
  upstreamListen: { host: string; port: number }
  /** gate state (IP counters, daily tokens) */
  stateDir: string
  /** kill switch: while this file exists nobody starts and every model request gets budget_exceeded */
  pauseFile: string
  /** the header with the visitor's address, believed only from a loopback peer (the tunnel); '' = socket address */
  clientIpHeader: string
  turnstile: { siteKey: string; secretFile: string; verifyUrl: string }
  ai: {
    mode: AiMode; credentialFile: string; upstream: string
    /** model ids a request may name (an id, or the id with a -YYYYMMDD date); any other model is rewritten to defaultModel */
    models: string[]
    defaultModel: string
  }
  pool: {
    /** <snapshotsDir>/<locale>/<snapshot>/{manifest.json, base/} */
    snapshotsDir: string
    /** where clones go: kept short, the instances' unix sockets must stay under 104 bytes */
    instancesDir: string
    /** a snapshot whose manifest names another code version is refused */
    codeVersion: string
    locales: Locale[]
    warmPerLocale: number
    maxLive: number
    ttlHours: number
    /** the instance's argv; {dir} {config} {port} {proxyPort} are replaced */
    command: string[]
    /** clone argv before <src> <dst>; default `cp -c -R` on macOS (APFS clone), `cp -R` elsewhere */
    cloneCommand: string[]
    portRange: [number, number]
    startTimeoutMs: number
    healthPath: string
    personaKey: string
    /** extra environment for every instance (the env is otherwise built from scratch) */
    env: Record<string, string>
    /** PATH of an instance */
    path: string
    sweepMs: number
    /** the user instances run as (never the gate's own: it can read the credential); null only with allowSameUser */
    runAs: { uid: number; gid: number } | null
    /** tests and development only: instances may run as the gate's own user */
    allowSameUser: boolean
    /** sudo, when the gate is not root: every touch of an instance (clone, start, kill, measure, remove) goes through
     * `sudo -n -u #uid -g #gid` */
    sudo: string
    /** an instance folder over this many MB ends its instance (the sweeper measures it with du) */
    diskCapMB: number
  }
  limits: {
    startsPerHour: number
    startsPerDay: number
    livePerIp: number
    /** addresses that skip startsPerHour and startsPerDay (the office, shared by the owner and QA): each the keyed hash
     * the gate stores in state.json `starts` (HMAC-SHA256(stateDir/ip-key, address), 32 hex), or a prefix of at least 8
     * hex characters. Never a raw address. Lower case. Empty = nobody is exempt */
    exemptIpHashes: string[]
    /** livePerIp for a listed address */
    exemptLivePerIp: number
    maxStreams: number
    /** how long a model request waits for a free stream before the neutral busy answer */
    streamWaitMs: number
    /** global daily cap of weighted tokens (UTC day) */
    dailyWeightedTokens: number
    /** model requests at once per instance (one visitor), inside maxStreams */
    streamsPerInstance: number
    /** the gate's own cap per instance: the instance's demo limit (GET /api/demo cap) × this */
    instanceCapMargin: number
  }
  links: { scriptedDemo: string; pricing: string; statusOrigins: string[] }
}

export class ConfigError extends Error {}

/** The models a demo request may name: the Sonnet ids (the demo's team default, build-snapshot.ts) and the small Haiku
 * ids Claude Code uses for its side calls (titles, summaries). Opus, which a subscription turn picks when nobody chose
 * a model (server/src/engine/claude.ts SUBSCRIPTION_DEFAULT_MODEL), is not one of them. */
export const DEFAULT_MODELS: readonly string[] = [
  'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5',
  'claude-haiku-5-5', 'claude-haiku-4-5',
]
export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Why the instances may not start as configured, or null. Instances that run as the gate's own user can read its
 * credential file, so that is refused unless allowSameUser (tests, development). */
export function instanceUserProblem(cfg: Pick<GateConfig, 'pool'>, gateUid: number): string | null {
  const r = cfg.pool.runAs
  if (cfg.pool.allowSameUser) return null
  if (!r) return 'config: pool.runAs {uid, gid} is required (instances must not run as the gate\'s own user, which can read the AI credential); allowSameUser: true is for tests only'
  if (r.uid === gateUid) return `config: pool.runAs.uid ${r.uid} is the gate's own user; instances would read the AI credential`
  if (r.uid === 0) return 'config: pool.runAs must not be root'
  return null
}

/** instancesDir + "/" + 8-character id stays at most this long, so the server's sockets inside fit 104 bytes */
export const MAX_INSTANCES_DIR = 40

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const loopbackHttp = (u: URL) => u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
/** https, or plain http to this machine (fakes in tests); never user:password */
export function credentialSafeUrl(s: string): boolean {
  try { const u = new URL(s); return !u.username && !u.password && (u.protocol === 'https:' || loopbackHttp(u)) } catch { return false }
}

export function loadConfig(file: string): GateConfig {
  let raw: unknown
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ConfigError(`config ${file}: ${(e as Error).message}`) }
  return parseConfig(raw, path.dirname(path.resolve(file)))
}

export function parseConfig(raw: unknown, base: string): GateConfig {
  if (!isObj(raw)) throw new ConfigError('config: not an object')
  const abs = (p: unknown, name: string) => { if (typeof p !== 'string' || !p) throw new ConfigError(`config: ${name} is required`); return path.resolve(base, p) }
  const str = (v: unknown, name: string, d?: string) => { if (v === undefined && d !== undefined) return d; if (typeof v !== 'string') throw new ConfigError(`config: ${name} must be a string`); return v }
  const num = (v: unknown, name: string, d: number) => { if (v === undefined) return d; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ConfigError(`config: ${name} must be a number`); return v }
  const hp = (v: unknown, name: string, port: number) => {
    const o = isObj(v) ? v : {}
    const host = str(o.host, `${name}.host`, '127.0.0.1')
    return { host, port: num(o.port, `${name}.port`, port) }
  }
  const publicOrigin = str(raw.publicOrigin, 'publicOrigin', 'https://demo.trina.app').replace(/\/+$/, '')
  try { const u = new URL(publicOrigin); if (u.origin !== publicOrigin) throw new Error() } catch { throw new ConfigError('config: publicOrigin must be an origin such as https://demo.trina.app') }
  const t = isObj(raw.turnstile) ? raw.turnstile : {}
  const ai = isObj(raw.ai) ? raw.ai : {}
  const p = isObj(raw.pool) ? raw.pool : {}
  const l = isObj(raw.limits) ? raw.limits : {}
  const k = isObj(raw.links) ? raw.links : {}
  const mode = str(ai.mode, 'ai.mode', 'claude-subscription') as AiMode
  if (!AI_MODES.includes(mode)) throw new ConfigError(`config: ai.mode must be ${AI_MODES.join(' or ')}`)
  const upstream = str(ai.upstream, 'ai.upstream', 'https://api.anthropic.com').replace(/\/+$/, '')
  if (!credentialSafeUrl(upstream)) throw new ConfigError('config: ai.upstream must be https:// (http:// only to this machine)')
  const verifyUrl = str(t.verifyUrl, 'turnstile.verifyUrl', 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
  if (!credentialSafeUrl(verifyUrl)) throw new ConfigError('config: turnstile.verifyUrl must be https:// (http:// only to this machine)')
  const locales = (Array.isArray(p.locales) ? p.locales : ['en', 'ko']) as Locale[]
  if (!locales.length || locales.some((x) => !LOCALES.includes(x))) throw new ConfigError(`config: pool.locales must be some of ${LOCALES.join(', ')}`)
  const command = p.command
  if (!Array.isArray(command) || !command.length || command.some((x) => typeof x !== 'string')) throw new ConfigError('config: pool.command must be a list of strings')
  const clone = p.cloneCommand ?? (process.platform === 'darwin' ? ['cp', '-c', '-R'] : ['cp', '-R'])
  if (!Array.isArray(clone) || !clone.length || clone.some((x) => typeof x !== 'string')) throw new ConfigError('config: pool.cloneCommand must be a list of strings')
  const range = (p.portRange ?? [19200, 19399]) as [number, number]
  if (!Array.isArray(range) || range.length !== 2 || !(range[0] > 1024 && range[1] >= range[0] + 2 && range[1] < 65536)) throw new ConfigError('config: pool.portRange must be [from, to] above 1024, at least three ports (each instance takes three)')
  const instancesDir = abs(p.instancesDir, 'pool.instancesDir')
  if (instancesDir.length + 9 > MAX_INSTANCES_DIR) throw new ConfigError(`config: pool.instancesDir is too long (${instancesDir.length} bytes; at most ${MAX_INSTANCES_DIR - 9}, the instances' unix sockets must fit 104 bytes)`)
  if (!command.some((x) => (x as string).includes('{dir}') || (x as string).includes('{config}'))) throw new ConfigError('config: pool.command must name {config} or {dir} (the sweeper only kills a process group whose command line holds its folder)')
  let runAs: { uid: number; gid: number } | null = null
  if (p.runAs !== undefined && p.runAs !== null) {
    const r = isObj(p.runAs) ? p.runAs : {}
    const id = (v: unknown, name: string) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new ConfigError(`config: pool.runAs.${name} must be a numeric id`); return v }
    runAs = { uid: id(r.uid, 'uid'), gid: id(r.gid, 'gid') }
  }
  if (p.allowSameUser !== undefined && typeof p.allowSameUser !== 'boolean') throw new ConfigError('config: pool.allowSameUser must be true or false')
  const models = ai.models === undefined ? [...DEFAULT_MODELS] : ai.models
  if (!Array.isArray(models) || !models.length || models.some((x) => typeof x !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,80}$/.test(x))) throw new ConfigError('config: ai.models must be a list of model ids')
  const defaultModel = str(ai.defaultModel, 'ai.defaultModel', DEFAULT_MODEL)
  if (!(models as string[]).includes(defaultModel)) throw new ConfigError('config: ai.defaultModel must be one of ai.models')
  const env = isObj(p.env) ? p.env : {}
  for (const [key, v] of Object.entries(env)) if (typeof v !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new ConfigError('config: pool.env must map NAMES to strings')
  const exempt = l.exemptIpHashes ?? []
  if (!Array.isArray(exempt) || exempt.some((x) => typeof x !== 'string' || !/^[0-9a-fA-F]{8,32}$/.test(x))) throw new ConfigError('config: limits.exemptIpHashes must be a list of keyed address hashes (8 to 32 hex characters, from state.json starts)')
  const origins = Array.isArray(k.statusOrigins) ? k.statusOrigins.filter((x): x is string => typeof x === 'string') : ['https://ax.trina.app']
  return {
    publicOrigin,
    listen: hp(raw.listen, 'listen', 19190),
    upstreamListen: hp(raw.upstreamListen, 'upstreamListen', 19191),
    stateDir: abs(raw.stateDir, 'stateDir'),
    pauseFile: abs(raw.pauseFile ?? path.join(String(raw.stateDir ?? '.'), 'PAUSE'), 'pauseFile'),
    clientIpHeader: str(raw.clientIpHeader, 'clientIpHeader', 'cf-connecting-ip').toLowerCase(),
    turnstile: { siteKey: str(t.siteKey, 'turnstile.siteKey'), secretFile: abs(t.secretFile, 'turnstile.secretFile'), verifyUrl },
    ai: { mode, credentialFile: abs(ai.credentialFile, 'ai.credentialFile'), upstream, models: models as string[], defaultModel },
    pool: {
      snapshotsDir: abs(p.snapshotsDir, 'pool.snapshotsDir'),
      instancesDir,
      codeVersion: str(p.codeVersion, 'pool.codeVersion'),
      locales,
      warmPerLocale: num(p.warmPerLocale, 'pool.warmPerLocale', 2),
      maxLive: num(p.maxLive, 'pool.maxLive', 10),
      ttlHours: num(p.ttlHours, 'pool.ttlHours', 24),
      command: command as string[],
      cloneCommand: clone as string[],
      portRange: range,
      startTimeoutMs: num(p.startTimeoutMs, 'pool.startTimeoutMs', 90_000),
      healthPath: str(p.healthPath, 'pool.healthPath', '/api/health'),
      personaKey: str(p.personaKey, 'pool.personaKey', 'newHire'),
      env: env as Record<string, string>,
      path: str(p.path, 'pool.path', '/usr/bin:/bin:/usr/sbin:/sbin'),
      sweepMs: num(p.sweepMs, 'pool.sweepMs', 60_000),
      runAs,
      allowSameUser: p.allowSameUser === true,
      sudo: str(p.sudo, 'pool.sudo', '/usr/bin/sudo'),
      diskCapMB: num(p.diskCapMB, 'pool.diskCapMB', 1024),
    },
    limits: {
      startsPerHour: num(l.startsPerHour, 'limits.startsPerHour', 3),
      startsPerDay: num(l.startsPerDay, 'limits.startsPerDay', 6),
      livePerIp: num(l.livePerIp, 'limits.livePerIp', 2),
      exemptIpHashes: (exempt as string[]).map((x) => x.toLowerCase()),
      exemptLivePerIp: num(l.exemptLivePerIp, 'limits.exemptLivePerIp', 6),
      maxStreams: num(l.maxStreams, 'limits.maxStreams', 4),
      streamWaitMs: num(l.streamWaitMs, 'limits.streamWaitMs', 30_000),
      dailyWeightedTokens: num(l.dailyWeightedTokens, 'limits.dailyWeightedTokens', 30_000_000),
      streamsPerInstance: Math.max(1, num(l.streamsPerInstance, 'limits.streamsPerInstance', 2)),
      instanceCapMargin: Math.max(1, num(l.instanceCapMargin, 'limits.instanceCapMargin', 1.2)),
    },
    links: {
      scriptedDemo: str(k.scriptedDemo, 'links.scriptedDemo', 'https://ax.trina.app/demo'),
      pricing: str(k.pricing, 'links.pricing', 'https://ax.trina.app/pricing'),
      statusOrigins: origins,
    },
  }
}

/** A secret file's content: it must be 0600-like (no group / other bits) and not empty. */
export function readSecretFile(file: string): string {
  const st = fs.statSync(file)
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new ConfigError(`${path.basename(file)}: must not be readable by group or others (chmod 600)`)
  const v = fs.readFileSync(file, 'utf8').trim()
  if (!v) throw new ConfigError(`${path.basename(file)}: empty`)
  return v
}
