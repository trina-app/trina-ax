// AI engine status for the admin screen ("관리자: AI 엔진", tab 5): installed? which version? logged in? lockdown
// test passed for this version? which models? Checks run the CLIs with short timeouts and never call a model.
//
// Auth modes (owner decision 2026-10-21): local-login (dev / this run: the engine runs as the current user with the
// owner's own `claude` / `codex` login), proxy (company key behind the model proxy; code-only), agent-own (the
// unprivileged _axagent account: Claude needs the owner's `claude setup-token` behind the proxy, Codex its own
// `codex login --device-auth`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EngineAccount, EngineId, EngineStatus, Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { REPO_ROOT } from '../app-config'
import { which } from '../config'

export const ENGINE_LABELS: Record<EngineId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }
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

const T: Record<string, Record<Locale, string>> = {
  notInstalled: { ko: '서버 맥에 설치되어 있지 않습니다.', en: 'Not installed on the server Mac.', id: 'Belum terpasang di Mac server.' },
  claudeLogin: { ko: '서버 맥에서 owner가 `claude`를 실행해 로그인해야 합니다.', en: 'The owner must sign in by running `claude` on the server Mac.', id: 'Owner harus masuk dengan menjalankan `claude` di Mac server.' },
  codexLogin: { ko: '서버 맥에서 owner가 `codex login`으로 로그인해야 합니다.', en: 'The owner must sign in with `codex login` on the server Mac.', id: 'Owner harus masuk dengan `codex login` di Mac server.' },
  setupToken: { ko: '전용 엔진 계정 모드에는 owner의 구독 장기 토큰이 필요합니다: 서버 맥에서 `claude setup-token`을 실행하고 만든 토큰을 이 화면에 붙여 넣어 주세요.', en: 'The dedicated engine account needs the owner\'s long-lived subscription token: run `claude setup-token` on the server Mac and paste the token here.', id: 'Akun mesin khusus memerlukan token langganan owner: jalankan `claude setup-token` di Mac server lalu tempel tokennya di sini.' },
  codexDevice: { ko: '전용 엔진 계정의 Codex 로그인(`codex login --device-auth`)이 아직 없습니다.', en: 'The engine account has no Codex sign-in yet (`codex login --device-auth`).', id: 'Akun mesin belum masuk ke Codex (`codex login --device-auth`).' },
  companyKey: { ko: '회사 키 모드인데 회사 API 키가 없습니다.', en: 'Company-key mode is on but no company API key is stored.', id: 'Mode kunci perusahaan aktif tetapi belum ada kunci API.' },
  version: { ko: '고정 버전과 다릅니다(잠금 시험을 통과한 버전: {pinned}).', en: 'Differs from the pinned version (lockdown-tested: {pinned}).', id: 'Berbeda dari versi yang dikunci (lulus uji penguncian: {pinned}).' },
  lockdown: { ko: '이 버전의 엔진 잠금 시험이 실패했습니다.', en: 'The engine lockdown test failed for this version.', id: 'Uji penguncian mesin gagal untuk versi ini.' },
  error: { ko: '상태를 확인하지 못했습니다: {e}', en: 'Could not check the status: {e}', id: 'Tidak dapat memeriksa status: {e}' },
}
const t = (k: keyof typeof T, l: Locale, vars: Record<string, string> = {}) => T[k]![l].replace(/\{(\w+)\}/g, (_, v: string) => vars[v] ?? '')

export interface EngineEnv {
  mode: 'dev' | 'prod'
  authMode: 'local-login' | 'proxy'
  claudeBin: string
  codexBin: string
  dataDir: string
  /** versions.json (pinned engine versions); null = no pin check */
  versionsFile: string | null
  /** Codex model catalog sources, first existing wins */
  codexCatalogs: string[]
  /** CODEX_HOME for `codex login status` (null = the CLI's default) */
  codexHome: string | null
  hasCompanyKey(engine: 'anthropic' | 'openai'): boolean
}

export function engineEnv(ctx: AppContext): EngineEnv {
  const codexHome = ctx.config.mode === 'prod' ? path.join(ctx.config.dataDir, 'agent', 'codex-home') : null
  const vf = path.join(REPO_ROOT, 'versions.json')
  return {
    mode: ctx.config.mode,
    authMode: ctx.config.engine.authMode,
    claudeBin: ctx.config.engine.claudeBin ?? ctx.engineConfig.claudeBin,
    codexBin: ctx.config.engine.codexBin ?? which('codex') ?? 'codex',
    dataDir: ctx.config.dataDir,
    versionsFile: fs.existsSync(vf) ? vf : null,
    codexCatalogs: [
      path.join(ctx.config.dataDir, 'engine', 'codex-catalog.json'),
      ...(codexHome ? [path.join(codexHome, 'models_cache.json')] : [path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'models_cache.json')]),
    ],
    codexHome,
    hasCompanyKey: (engine) => !!ctx.db.query("SELECT 1 FROM engine_accounts WHERE engine = ? AND status = 'ok'").get(engine),
  }
}

/** auth mode as shown to the admin */
export function shownAuthMode(env: EngineEnv): EngineStatus['authMode'] {
  if (env.authMode === 'proxy') return 'proxy'
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
  const base = { id, label: ENGINE_LABELS[id], enabled, authMode: shownAuthMode(env), checkedAt: new Date().toISOString() }
  const bin = id === 'claude-code' ? env.claudeBin : env.codexBin
  const v = await runCli(bin, ['--version'], { timeoutMs: 10_000 })
  const version = v.code === 0 ? versionOf(v.stdout + v.stderr) : null
  const models = id === 'claude-code' ? CLAUDE_MODELS : codexModels(env)
  if (!version) {
    const missing = v.error || v.code === 127 || /ENOENT|not found|No such file/i.test(v.error ?? v.stderr)
    return { ...base, installed: false, version: null, status: missing || v.code === null ? 'not_installed' : 'error', detail: missing ? t('notInstalled', locale) : t('error', locale, { e: (v.stderr || v.stdout).trim().slice(0, 200) }), models }
  }
  const out = (status: EngineStatus['status'], detail: string | null): EngineStatus => ({ ...base, installed: true, version, status, detail, models })

  // login
  const mode = shownAuthMode(env)
  if (mode === 'proxy') {
    if (!env.hasCompanyKey(id === 'claude-code' ? 'anthropic' : 'openai')) return out('not_logged_in', t('companyKey', locale))
  } else if (id === 'claude-code') {
    if (mode === 'agent-own') {
      if (!fs.existsSync(path.join(env.dataDir, 'secrets', 'claude-setup-token'))) return out('not_logged_in', t('setupToken', locale))
    } else {
      const s = await runCli(bin, ['auth', 'status', '--json'], { timeoutMs: 15_000 })
      let logged: boolean | null = null
      try { logged = JSON.parse(s.stdout).loggedIn === true } catch {}
      if (logged === null) return out('error', t('error', locale, { e: (s.stderr || s.stdout || (s.timedOut ? 'timeout' : '')).trim().slice(0, 200) }))
      if (!logged) return out('not_logged_in', t('claudeLogin', locale))
    }
  } else {
    const s = await runCli(bin, ['login', 'status'], { timeoutMs: 15_000, env: env.codexHome ? { CODEX_HOME: env.codexHome } : {} })
    const text = s.stdout + s.stderr
    if (s.code !== 0 || !/logged in/i.test(text) || /not logged in/i.test(text)) return out('not_logged_in', mode === 'agent-own' ? t('codexDevice', locale) : t('codexLogin', locale))
  }

  // pinned version + lockdown regression result
  const pin = pinned(env, id)
  if (pin && pin !== version) return out('version_unsupported', t('version', locale, { pinned: pin }))
  const lock = lockdownResult(env, id)
  if (lock && !lock.ok && (lock.version === null || lock.version === version)) return out('lockdown_failed', t('lockdown', locale))
  return out('ok', null)
}

/** Per-context cache of the last check of each engine. */
export class EngineStatusCache {
  private last = new Map<EngineId, { at: number; status: EngineStatus; locale: Locale }>()
  private inflight = new Map<EngineId, Promise<EngineStatus>>()
  constructor(private env: () => EngineEnv) {}

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

// ---------------- company keys (proxy mode; code-only for now) ----------------
interface AccountRow { id: string; engine: 'anthropic' | 'openai'; secret_ref: string; label: string | null; status: 'ok' | 'invalid'; checked_at: string | null; hint: string | null }
export function listAccounts(ctx: AppContext): EngineAccount[] {
  return (ctx.db.query('SELECT id, engine, secret_ref, label, status, checked_at, hint FROM engine_accounts ORDER BY id').all() as AccountRow[])
    .filter((r) => r.engine === 'anthropic' || r.engine === 'openai')
    .map((r) => ({ id: r.id, engine: r.engine, label: r.label, status: r.status, checkedAt: r.checked_at, hint: r.hint }))
}

/** The secret goes to <data>/secrets/<id>.key (0600, folder 0700); the DB keeps only the file name and a hint. */
export function addAccount(ctx: AppContext, id: string, engine: 'anthropic' | 'openai', label: string | null, secret: string): EngineAccount {
  const dir = path.join(ctx.config.dataDir, 'secrets')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = `${id}.key`
  fs.writeFileSync(path.join(dir, file), secret, { mode: 0o600 })
  const hint = secret.slice(-4)
  ctx.db.query("INSERT INTO engine_accounts (id, engine, secret_ref, label, status, checked_at, hint) VALUES (?, ?, ?, ?, 'ok', NULL, ?)").run(id, engine, file, label, hint)
  return { id, engine, label, status: 'ok', checkedAt: null, hint }
}

export function deleteAccount(ctx: AppContext, id: string): boolean {
  const r = ctx.db.query('SELECT secret_ref FROM engine_accounts WHERE id = ?').get(id) as { secret_ref: string } | null
  if (!r) return false
  ctx.db.query('DELETE FROM engine_accounts WHERE id = ?').run(id)
  if (/^[A-Za-z0-9_.-]+$/.test(r.secret_ref)) fs.rmSync(path.join(ctx.config.dataDir, 'secrets', r.secret_ref), { force: true })
  return true
}
