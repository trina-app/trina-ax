// AI engine status for the admin screen ("관리자: AI 엔진", tab 5): installed? which version? logged in? lockdown
// test passed for this version? which models? Checks run the CLIs with short timeouts and never call a model.
//
// Auth modes: local-login (dev / office: the engine runs as the current user with the owner's own `claude` /
// `codex` login) and managed (production, cloud, Linux: the team's AI connections behind the model proxy, Admin > AI
// connections; an engine is "signed in" when the team has a usable connection of its family). agent-own is how an
// older prod server without managed mode is shown.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineId, EngineStatus, Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { REPO_ROOT } from '../app-config'
import { which } from '../config'
import { allowedCredentialKinds } from '../app-config'
import { teamCredentialSummary } from '../credentials/resolve'
import { resolveLayout } from '../system/layout'
import { codexCatalogFor, CODEX_COMPATIBLE_VERSIONS } from '../engine/codex'
import { codexLoginState, type CodexLoginState } from '../native'
import { CODEX_PROD_BETA } from '../chat/engines'
import { readApiEngine, redact } from '../engine/api-agent'
import { apiEngineFetch } from '../system/egress'
import { hostKind, type HostKind } from '../system/deployment'
import { engineStatusMessages } from '../system/messages-linux'

export const ENGINE_LABELS: Record<EngineId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', api: 'API' }
export const CLAUDE_MODELS = [
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'haiku', label: 'Claude Haiku' },
]
/** status checks are cached this long (GET /api/admin/engines); POST .../check always runs */
const CACHE_MS = 10 * 60_000

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }

/** Run a CLI with a hard timeout; output capped at 64 KB. */
export async function runCli(cmd: string, args: string[], o: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<RunResult> {
  let p: ReturnType<typeof Bun.spawn>
  try {
    p = Bun.spawn([cmd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...o.env } })
  } catch (e) {
    return { code: null, stdout: '', stderr: '', timedOut: false, error: (e as Error).message }
  }
  let timedOut = false
  const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL') }, o.timeoutMs ?? 15_000)
  const read = async (s: ReadableStream<Uint8Array> | null | undefined | number) => {
    if (!s || typeof s === 'number') return ''
    const txt = await new Response(s).text()
    return txt.slice(0, 64 * 1024)
  }
  const [stdout, stderr, code] = await Promise.all([read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>), p.exited])
  clearTimeout(t)
  return { code: timedOut ? null : code, stdout, stderr, timedOut }
}

export const T: Record<string, Record<Locale, string>> = {
  notInstalled: { ko: '서버 맥에 설치되어 있지 않습니다.', en: 'Not installed on the server Mac.', id: 'Belum terpasang di Mac server.' },
  apiNotSet: { ko: '아직 설정하지 않았습니다. 아래에서 API 주소·모델·키를 넣어 주세요.', en: 'Not set up yet. Enter the API address, model and key below.', id: 'Belum diatur. Masukkan alamat API, model, dan kunci di bawah.' },
  apiKey: { ko: 'API 키가 맞지 않습니다(401/403).', en: 'The API key was refused (401/403).', id: 'Kunci API ditolak (401/403).' },
  apiModel: { ko: '이 제공자에 모델 "{model}"이 없어요. 모델 이름을 확인해 주세요.', en: 'The provider has no model "{model}". Check the model name.', id: 'Penyedia tidak punya model "{model}". Periksa nama model.' },
  apiModelUnchecked: { ko: '주소와 키는 맞아요. 제공자가 모델 목록을 주지 않아서 모델 이름은 확인하지 못했어요.', en: 'The address and key work. The provider gives no model list, so the model name was not checked.', id: 'Alamat dan kunci berfungsi. Penyedia tidak memberi daftar model, jadi nama model belum diperiksa.' },
  apiKeyUnchecked: { ko: '주소와 모델은 맞아요. 제공자가 키 확인 주소를 주지 않아서 키는 확인하지 못했어요.', en: 'The address and model work. The provider has no key check address, so the key was not checked.', id: 'Alamat dan model berfungsi. Penyedia tidak punya alamat pemeriksaan kunci, jadi kunci belum diperiksa.' },
  apiUnreachable: { ko: 'API 주소에 연결하지 못했어요: {e}', en: 'The API address could not be reached: {e}', id: 'Alamat API tidak bisa dihubungi: {e}' },
  apiHttp: { ko: 'API 주소가 오류를 보냈어요(HTTP {status}). 주소를 확인해 주세요.', en: 'The API address sent back an error (HTTP {status}). Check the address.', id: 'Alamat API mengirim galat (HTTP {status}). Periksa alamatnya.' },
  claudeLogin: { ko: '서버 맥에서 owner가 `claude`를 실행해 로그인해야 합니다.', en: 'The owner must sign in by running `claude` on the server Mac.', id: 'Owner harus masuk dengan menjalankan `claude` di Mac server.' },
  codexLogin: { ko: '서버 맥에서 owner가 `codex login`으로 로그인해야 합니다.', en: 'The owner must sign in with `codex login` on the server Mac.', id: 'Owner harus masuk dengan `codex login` di Mac server.' },
  setupToken: { ko: '전용 엔진 계정 모드에는 owner의 구독 장기 토큰이 필요합니다: 서버 맥에서 `claude setup-token`으로 토큰을 만들고 `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"`으로 저장하세요(secrets/claude-oauth-token, docs/INSTALL.md 2.4).', en: 'The dedicated engine account needs the owner\'s long-lived subscription token: make one with `claude setup-token` on the server Mac and store it with `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"` (secrets/claude-oauth-token, docs/INSTALL.md 2.4).', id: 'Akun mesin khusus memerlukan token langganan owner: buat dengan `claude setup-token` di Mac server lalu simpan dengan `pbpaste | sudo "/Library/Application Support/mycel/root/set-claude-token"` (secrets/claude-oauth-token, docs/INSTALL.md 2.4).' },
  setupTokenExpired: { ko: 'Claude 구독 장기 토큰이 만료되었습니다(1년). `claude setup-token`으로 새 토큰을 만들어 다시 저장하세요.', en: 'The long-lived Claude subscription token has expired (one year). Make a new one with `claude setup-token` and store it again.', id: 'Token langganan Claude sudah kedaluwarsa (satu tahun). Buat yang baru dengan `claude setup-token` lalu simpan lagi.' },
  setupTokenInvalid: { ko: 'Claude가 구독 장기 토큰을 거절했습니다(취소되었거나 잘못 붙여 넣음). `claude setup-token`으로 새 토큰을 만들어 다시 저장하세요.', en: 'Claude refused the long-lived subscription token (revoked or pasted wrong). Make a new one with `claude setup-token` and store it again.', id: 'Claude menolak token langganan (dicabut atau salah tempel). Buat yang baru dengan `claude setup-token` lalu simpan lagi.' },
  codexDevice: { ko: '전용 엔진 계정의 Codex 로그인이 아직 없습니다. 서버 맥에서 owner가 관리 명령 `admin.js codex-login`을 한 번 실행해 나오는 주소와 코드로 로그인합니다(docs/INSTALL.md 2.5).', en: 'The engine account has no Codex sign-in yet. On the server Mac the owner runs the admin command `admin.js codex-login` once and signs in with the address and code it prints (docs/INSTALL.md 2.5).', id: 'Akun mesin belum masuk ke Codex. Di Mac server, owner menjalankan perintah admin `admin.js codex-login` sekali lalu masuk dengan alamat dan kode yang ditampilkan (docs/INSTALL.md 2.5).' },
  codexCatalog: { ko: 'Codex 모델 목록(잠금 카탈로그 model_catalog.json)이 엔진 폴더에 없습니다. 설치 스크립트를 다시 실행하세요.', en: 'The Codex model list (locked catalog model_catalog.json) is missing from the engine folder. Run the installer again.', id: 'Daftar model Codex (katalog terkunci model_catalog.json) tidak ada di folder mesin. Jalankan installer lagi.' },
  launcherDown: { ko: '실행기(엔진 계정 데몬)가 답하지 않습니다.', en: 'The launcher (engine account daemon) does not answer.', id: 'Launcher (daemon akun mesin) tidak menjawab.' },
  companyKey: { ko: '회사 키 모드인데 회사 API 키가 없습니다.', en: 'Company-key mode is on but no company API key is stored.', id: 'Mode kunci perusahaan aktif tetapi belum ada kunci API.' },
  managedNone: { ko: 'AI 연결이 없어요. 관리자 > AI 연결에서 추가해 주세요.', en: 'No AI connection. Add one in Admin > AI connections.', id: 'Tidak ada koneksi AI. Tambahkan di Admin > Koneksi AI.' },
  managedNoneDetail: { ko: '이 엔진의 AI 연결을 지금 쓸 수 없어요(거절·만료·한도). 관리자 > AI 연결을 확인해 주세요.', en: 'This engine\'s AI connections cannot be used now (refused, expired, limit). Check Admin > AI connections.', id: 'Koneksi AI mesin ini tidak bisa dipakai sekarang (ditolak, kedaluwarsa, batas). Periksa Admin > Koneksi AI.' },
  version: { ko: '아직 검증하지 않은 버전입니다(고정 버전: {pinned}; 잠금 시험을 통과한 버전: {tested}).', en: 'This version has not been tested (pinned: {pinned}; lockdown-tested: {tested}).', id: 'Versi ini belum diuji (versi yang dikunci: {pinned}; lulus uji penguncian: {tested}).' },
  lockdown: { ko: '이 버전의 엔진 잠금 시험이 실패했습니다.', en: 'The engine lockdown test failed for this version.', id: 'Uji penguncian mesin gagal untuk versi ini.' },
  error: { ko: '상태를 확인하지 못했습니다: {e}', en: 'Could not check the status: {e}', id: 'Tidak dapat memeriksa status: {e}' },
}
const t = (k: keyof typeof T, l: Locale, vars: Record<string, string> = {}) => T[k]![l].replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')
/** t() with the entries that name the server Mac replaced for a Linux server or the hosted cloud */
const hostT = (env: EngineEnv): typeof t => {
  const over = env.host && env.host !== 'mac' ? engineStatusMessages(env.host, env.base ?? '') : {}
  return (k, l, vars = {}) => (over[k]?.[l] ?? T[k]![l]).replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')
}

export interface EngineEnv {
  mode: 'dev' | 'prod'
  authMode: 'local-login' | 'managed'
  claudeBin: string
  codexBin: string
  dataDir: string
  /** <install base>/secrets (the installer's 700 folder, kept out of Time Machine); the diagnostics read the same */
  secretsDir: string
  /** versions.json (pinned engine versions); null = no pin check */
  versionsFile: string | null
  /** Codex model catalog sources, first existing wins */
  codexCatalogs: string[]
  /** prod: the engine account's Codex login, asked of the launcher (the server account cannot read it). null = the
   * launcher did not answer. Absent (dev): `codex login status` of the owner's own login. */
  codexLogin?: () => Promise<CodexLoginState | null>
  /** managed: the team's AI connections of a family (usable now / all) */
  credentials?: (family: 'anthropic' | 'openai') => { total: number; usable: number }
  /** the server's database */
  db?: import('bun:sqlite').Database
  /** which machine the status lines talk about (deployment.ts hostKind; absent = the Mac wording) and the install base */
  host?: HostKind
  base?: string
}

export function engineEnv(ctx: AppContext): EngineEnv {
  const prod = ctx.config.mode === 'prod'
  const vf = path.join(REPO_ROOT, 'versions.json')
  // prod: the installer's engine only (the launcher allows nothing else) and its locked catalog next to it
  const codexBin = prod ? ctx.config.engine.codexBin ?? '' : ctx.config.engine.codexBin ?? which('codex') ?? 'codex'
  const sock = ctx.config.engine.launcherSock ?? path.join(ctx.engineConfig.runDir, 'launcher.sock')
  return {
    mode: ctx.config.mode,
    authMode: ctx.config.engine.authMode,
    claudeBin: ctx.config.engine.claudeBin ?? ctx.engineConfig.claudeBin,
    codexBin,
    dataDir: ctx.config.dataDir,
    secretsDir: resolveLayout(ctx.config).secretsDir,
    versionsFile: fs.existsSync(vf) ? vf : null,
    codexCatalogs: prod ? [codexCatalogFor(codexBin)] : [
      path.join(ctx.config.dataDir, 'codex-catalog.json'), // written by chat/engines.ts from the owner's models_cache
      path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'models_cache.json'),
    ],
    ...(prod && ctx.config.engine.authMode !== 'managed' ? { codexLogin: () => codexLoginState(sock) } : {}),
    ...(ctx.config.engine.authMode === 'managed' ? { credentials: (family: 'anthropic' | 'openai') => teamCredentialSummary(ctx.db, family, allowedCredentialKinds(ctx.config)) } : {}),
    db: ctx.db,
    host: hostKind(ctx.config), base: resolveLayout(ctx.config).base,
  }
}

/** auth mode as shown to the admin */
export function shownAuthMode(env: EngineEnv): EngineStatus['authMode'] {
  if (env.authMode === 'managed') return 'managed'
  return env.mode === 'prod' ? 'agent-own' : 'local-login'
}

function pinned(env: EngineEnv, id: EngineId): string | null {
  if (!env.versionsFile) return null
  try { const v = JSON.parse(fs.readFileSync(env.versionsFile, 'utf8')); return typeof v[id === 'claude-code' ? 'claude-code' : 'codex-cli'] === 'string' ? v[id === 'claude-code' ? 'claude-code' : 'codex-cli'] : null } catch { return null }
}

/** `<data>/engine/lockdown-<engine>.json` { ok, version } written by the lockdown regression run. */
function lockdownResult(env: EngineEnv, id: EngineId): { ok: boolean; version: string | null } | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'engine', `lockdown-${id}.json`), 'utf8'))
    return typeof v.ok === 'boolean' ? { ok: v.ok, version: typeof v.version === 'string' ? v.version : null } : null
  } catch { return null }
}

export function codexModels(env: EngineEnv): { id: string; label: string }[] {
  for (const f of env.codexCatalogs) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (!Array.isArray(j.models)) continue
      return j.models.filter((m: any) => typeof m?.slug === 'string' && m.visibility !== 'hide').map((m: any) => ({ id: m.slug, label: typeof m.display_name === 'string' ? m.display_name : m.slug }))
    } catch {}
  }
  return []
}

const versionOf = (s: string) => /(\d+\.\d+\.\d+)/.exec(s)?.[1] ?? null

export async function checkEngine(id: EngineId, env: EngineEnv, enabled: boolean, locale: Locale): Promise<EngineStatus> {
  if (id === 'api') return checkApiEngine(env, enabled, locale)
  const t = hostT(env) // Linux / the hosted cloud wording (system/messages-linux.ts); the Mac's stays as above
  const base = { id, label: ENGINE_LABELS[id], enabled, authMode: shownAuthMode(env), checkedAt: new Date().toISOString(),
    ...(id === 'codex' && env.mode === 'prod' && CODEX_PROD_BETA && env.authMode !== 'managed' ? { beta: true } : {}) }
  const bin = id === 'claude-code' ? env.claudeBin : env.codexBin
  const v = await runCli(bin, ['--version'], { timeoutMs: 10_000 })
  const version = v.code === 0 ? versionOf(v.stdout + v.stderr) : null
  const models = id === 'claude-code' ? CLAUDE_MODELS : codexModels(env)
  if (!version) {
    const missing = v.error || v.code === 127 || /ENOENT|not found|No such file/i.test(v.error ?? v.stderr)
    // a timeout is not "not installed" (a first start after a long idle can take over 10 s): an error, kept in the picker
    return { ...base, installed: false, version: null, status: missing ? 'not_installed' : 'error', detail: missing ? t('notInstalled', locale) : t('error', locale, { e: (v.stderr || v.stdout || (v.timedOut ? 'timeout' : '')).trim().slice(0, 200) }), models }
  }
  const out = (status: EngineStatus['status'], detail: string | null): EngineStatus => ({ ...base, installed: true, version, status, detail, models })
  if (id === 'codex' && env.mode === 'prod' && !models.length) return out('error', t('codexCatalog', locale))

  // login
  const mode = shownAuthMode(env)
  if (mode === 'managed') {
    // the team's AI connections of this engine's family (Admin > AI connections): none, or none usable now
    const c = env.credentials?.(id === 'claude-code' ? 'anthropic' : 'openai') ?? { total: 0, usable: 0 }
    if (!c.usable) return out('not_logged_in', t(c.total ? 'managedNoneDetail' : 'managedNone', locale))
  } else if (id === 'claude-code') {
    if (mode === 'agent-own') {
      // an installed server that is not in managed mode (hand-set local-login): the engine account has no login of its own
      return out('not_logged_in', t('setupToken', locale))
    } else {
      const s = await runCli(bin, ['auth', 'status', '--json'], { timeoutMs: 15_000 })
      let logged: boolean | null = null
      try { logged = JSON.parse(s.stdout).loggedIn === true } catch {}
      if (logged === null) return out('error', t('error', locale, { e: (s.stderr || s.stdout || (s.timedOut ? 'timeout' : '')).trim().slice(0, 200) }))
      if (!logged) return out('not_logged_in', t('claudeLogin', locale))
    }
  } else if (env.codexLogin) {
    // the engine account's own login (<agent root>/codex-auth), as the launcher sees it; never a token
    const s = await env.codexLogin()
    if (!s) return out('error', t('launcherDown', locale))
    if (!s.loggedIn) return out('not_logged_in', t('codexDevice', locale))
  } else {
    const s = await runCli(bin, ['login', 'status'], { timeoutMs: 15_000 })
    const text = s.stdout + s.stderr
    if (s.code !== 0 || !/logged in/i.test(text) || /not logged in/i.test(text)) return out('not_logged_in', mode === 'agent-own' ? t('codexDevice', locale) : t('codexLogin', locale))
  }

  // pinned version + lockdown regression result
  const pin = pinned(env, id)
  const compatible = id === 'codex' && CODEX_COMPATIBLE_VERSIONS.some(v => v === version)
  const lock = lockdownResult(env, id)
  if (lock && !lock.ok && (lock.version === null || lock.version === version)) return out('lockdown_failed', t('lockdown', locale))
  if (pin && pin !== version && !compatible) {
    const tested = [...new Set([pin, ...(id === 'codex' ? CODEX_COMPATIBLE_VERSIONS : [])])].join(', ')
    return out('version_unsupported', t('version', locale, { pinned: pin, tested }))
  }
  return out('ok', null)
}

/** The model ids of a provider's list that name `model`: as is, Gemini's "models/<id>", Ollama's "<id>:latest". */
export function modelListed(ids: string[], model: string): boolean {
  const norm = (m: string) => m.replace(/^models\//, '').replace(/:latest$/, '')
  const want = norm(model)
  return ids.some((id) => id === model || norm(id) === want)
}

/**
 * The API engine (engine/api-agent.ts), without a model call: configured? does the address answer? does the provider
 * accept the key (GET /models; OpenRouter lists models without a key, so its GET /key)? is the model in the provider's
 * list? A provider without a list is "ok" with a note that the model was not checked.
 */
async function checkApiEngine(env: EngineEnv, enabled: boolean, locale: Locale): Promise<EngineStatus> {
  const conf = readApiEngine(env.dataDir)
  let provider: string | undefined
  try { provider = conf ? new URL(conf.baseUrl).host : undefined } catch {}
  const base = { id: 'api' as const, label: conf ? `${conf.label} (API)` : ENGINE_LABELS.api, enabled, authMode: 'api-key' as const, ...(provider ? { provider } : {}), checkedAt: new Date().toISOString(), version: null,
    models: conf ? [{ id: conf.model, label: conf.label }] : [] }
  if (!conf) return { ...base, installed: false, status: 'not_installed', detail: t('apiNotSet', locale) }
  const out = (status: EngineStatus['status'], detail: string | null): EngineStatus => ({ ...base, installed: true, status, detail })
  try {
    // Anthropic's model list wants x-api-key (its OpenAI-compatible chat endpoint takes the Bearer header): a refused
    // list would leave a working Claude API engine out of the composer (admin/engine-choice.ts readyEngines)
    const anthropic = /^https:\/\/api\.anthropic\.com\//.test(conf.baseUrl + '/')
    const openrouter = /^https:\/\/openrouter\.ai\//.test(conf.baseUrl + '/')
    const headers: Record<string, string> = conf.key ? { Authorization: `Bearer ${conf.key}`, ...(anthropic ? { 'x-api-key': conf.key, 'anthropic-version': '2023-06-01' } : {}) } : {}
    const get = (p: string) => apiEngineFetch()(`${conf.baseUrl}${p}`, { headers, signal: AbortSignal.timeout(10_000) })
    // OpenRouter: GET /key (older servers: /auth/key); neither there = the key is not checked, and the card says so
    let keyUnchecked = false
    if (openrouter) {
      let k = await get('/key')
      if (k.status === 404) k = await get('/auth/key')
      if (k.status === 401 || k.status === 403) return out('not_logged_in', t('apiKey', locale))
      keyUnchecked = !k.ok
    }
    // Anthropic's list comes in pages (20 by default)
    const r = await get(anthropic ? '/models?limit=1000' : '/models')
    if (r.status === 401 || r.status === 403) return out('not_logged_in', t('apiKey', locale))
    // no list here (404, 405): the address and key are not proven wrong, the model is not checked
    if (r.status === 404 || r.status === 405) return out('ok', t('apiModelUnchecked', locale))
    if (!r.ok) return out('error', t('apiHttp', locale, { status: String(r.status) }))
    let ids: string[] = []
    let more = false
    try {
      const j = await r.json() as { data?: { id?: unknown }[]; models?: { name?: unknown; id?: unknown }[]; has_more?: unknown }
      const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []
      ids = list.map((m: any) => (typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : '')).filter(Boolean)
      more = j.has_more === true
    } catch {}
    if (!ids.length || (more && !modelListed(ids, conf.model))) return out('ok', t('apiModelUnchecked', locale))
    if (!modelListed(ids, conf.model)) return out('error', t('apiModel', locale, { model: conf.model.slice(0, 100) }))
    return out('ok', keyUnchecked ? t('apiKeyUnchecked', locale) : null)
  } catch (e) {
    const err = e as Error
    const why = err?.cause instanceof Error ? `${err.message}: ${err.cause.message}` : String(err?.message ?? e)
    return out('error', t('apiUnreachable', locale, { e: redact(why, conf.key).slice(0, 200) }))
  }
}

/** Per-context cache of the last check of each engine. */
export class EngineStatusCache {
  private last = new Map<EngineId, { at: number; status: EngineStatus; locale: Locale }>()
  private inflight = new Map<EngineId, Promise<EngineStatus>>()
  constructor(private env: () => EngineEnv) {}

  /** Drop one engine's last check (its setup changed). */
  forget(id: EngineId) { this.last.delete(id) }

  /** The last check's status, without checking. */
  peek(id: EngineId): EngineStatus['status'] | null { return this.last.get(id)?.status.status ?? null }

  async get(id: EngineId, enabled: boolean, locale: Locale, force = false): Promise<EngineStatus> {
    const c = this.last.get(id)
    if (!force && c && Date.now() - c.at < CACHE_MS && c.locale === locale) return { ...c.status, enabled }
    let p = this.inflight.get(id)
    if (!p) {
      p = checkEngine(id, this.env(), enabled, locale).finally(() => this.inflight.delete(id))
      this.inflight.set(id, p)
    }
    const s = await p
    this.last.set(id, { at: Date.now(), status: s, locale })
    return { ...s, enabled }
  }
}

/** One cache per server, shared by Admin > AI engines and the composer's engine list (admin/engine-choice.ts). */
const caches = new WeakMap<AppContext, EngineStatusCache>()
export function engineStatusCache(ctx: AppContext): EngineStatusCache {
  let c = caches.get(ctx)
  if (!c) { c = new EngineStatusCache(() => engineEnv(ctx)); caches.set(ctx, c) }
  return c
}
