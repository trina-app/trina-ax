// How much the API engine's model can read at once (its context window, in tokens), so a chat's history, the
// instructions and the tool list are fitted into it (docs/decisions/20261118-history-small-models.md). A local model
// (Ollama, LM Studio, llama.cpp) often runs with 4k-32k tokens: the history window made for Claude (40k tokens) alone
// overflowed it. Ollama does not even refuse: it cuts the start of the prompt, and the instructions went first.
//
// Learned, never set by hand: what the model's own server says (Ollama /api/ps and /api/show, LM Studio
// /api/v0/models, llama.cpp /props, the OpenAI-compatible model list: OpenRouter, vLLM, Groq, Together …), or the
// number a refusal named ("maximum context length is 8192 tokens"). `exact`: the size the model's server says it runs
// with now; a guess (a local address that said nothing, a model loaded later) and a refusal's number only shrink the
// window, they never refuse a turn and never cut the tool list (a refusal's text can echo words a person or a tool
// wrote, so it is read only in the provider's own wording, outside quotes and JSON, and forgotten once a request with
// more tokens than it named went through).
//
// The probes go to the address the admin set (and its own /api paths), through the same address check as the turns
// (system/egress.ts apiEngineFetch). The key goes only to the address it was saved for (the /models list), never to the
// other paths of that host.
import type { ApiEngineConf } from './api-agent'
import { apiEngineFetch } from '../system/egress'
import { isLocalAddress, isPublicAddress } from '../tools/web-fetch'

export interface ContextSize { tokens: number; exact: boolean; source: 'ollama' | 'lmstudio' | 'llamacpp' | 'models' | 'refusal' | 'local-guess' }

/** A local address that told nothing: what #1284's prompt budget assumes for it too (most local models run 8k-32k). */
export const LOCAL_GUESS_TOKENS = 32_000
/** the context an Ollama model loads with when neither its num_ctx nor OLLAMA_CONTEXT_LENGTH says otherwise (2048
 * before Ollama 0.6), and LM Studio's default load size */
export const OLLAMA_DEFAULT_TOKENS = 4_096
export const OLLAMA_OLD_DEFAULT_TOKENS = 2_048
export const LMSTUDIO_DEFAULT_TOKENS = 4_096
/** how long a model loaded by the look-up stays loaded (Ollama's own default; the turn's request follows at once) */
const OLLAMA_KEEP_ALIVE = '5m'
/** a guess (a model not loaded yet) is looked at again this soon: once loaded, its server says the real size */
const GUESS_CACHE_MS = 60_000
/** a probe's answer is kept this long (a model loaded with another size is seen at most this late) */
export const CONTEXT_CACHE_MS = 10 * 60_000
/** a probe that learned nothing is not repeated for this long: a local server (just started, model loading) soon, a
 * cloud provider that does not say (most do not) only every CONTEXT_CACHE_MS */
const LOCAL_MISS_CACHE_MS = 60_000
/** all probes of one look-up together: a turn waits at most this long for them (each one PROBE_TIMEOUT_MS) */
const PROBES_TIMEOUT_MS = 5_000
/** a probe's answer larger than this is not read (a model list is a few kB, OpenRouter's about 500 kB) */
export const PROBE_BODY_MAX = 1_000_000
/** the number a refusal named: kept this long (it is the model's real limit) */
const REFUSAL_CACHE_MS = 60 * 60_000
const PROBE_TIMEOUT_MS = 3_000
/** below this a number is not a context size (a field that means something else) */
const MIN_TOKENS = 512
const MAX_TOKENS = 100_000_000

const keyOf = (c: Pick<ApiEngineConf, 'baseUrl' | 'model'>) => `${c.baseUrl}\0${c.model}`
const probed = new Map<string, { size: ContextSize | null; at: number }>()
const refused = new Map<string, { tokens: number; at: number }>()
const inflight = new Map<string, Promise<ContextSize | null>>()

const num = (x: unknown): number | null => {
  const n = typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x) : x
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_TOKENS && n <= MAX_TOKENS ? n : null
}

/** The address is on this computer or the local network (localhost, a private IP, a .local / .lan name, one label). */
export function isLocalApiAddress(baseUrl: string): boolean {
  let host: string
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '') } catch { return false }
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(local|lan|internal|home\.arpa)$/.test(host)) return true
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPublicAddress(host) || isLocalAddress(host)
  return !host.includes('.')
}

/** The address of a model that may take long to start answering, so its first answer is waited for (engine/api-agent.ts
 * HEADERS_TIMEOUT_MS): this computer or a private network, and the same kind of address reached over Tailscale. An IP
 * literal counts only when it is not public (loopback, 10/8, 172.16/12, 192.168/16, link-local, fc00::/7, CGNAT
 * 100.64/10); the server's own subnet does not matter here (on EC2 it can hold a public IPv6 /64). Names: localhost,
 * .local / .lan / .internal / .home.arpa, one label, and *.ts.net (Tailscale). */
export function isPatientApiAddress(baseUrl: string): boolean {
  let host: string
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '') } catch { return false }
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(local|lan|internal|home\.arpa|ts\.net)$/.test(host)) return true
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPublicAddress(host)
  return !host.includes('.')
}

/** The provider's own words in a refusal: the error object's message (OpenAI-style JSON, possibly cut off), else the
 * text; anything quoted inside it ("…", `…`) and any JSON inside it ({…}, […]) is left out, as a provider repeats the
 * request's own text there (tool arguments, the person's words). */
function refusalWords(body: string): { text: string; nCtx: number | null } {
  const raw = body.replace(/^HTTP \d{3}:\s*/, '')
  let text = raw
  let nCtx: number | null = null
  try {
    const j = JSON.parse(raw) as any
    const e = j?.error ?? j
    if (typeof e === 'string') text = e
    else if (e && typeof e === 'object') { text = typeof e.message === 'string' ? e.message : ''; nCtx = num(e.n_ctx) }
  } catch {
    // a cut-off JSON body (the log keeps 300 characters): its "message" string as far as it goes
    if (/^\s*[{[]/.test(raw)) {
      const m = /"message"\s*:\s*"((?:\\.|[^"\\])*)/.exec(raw)
      text = m ? m[1]!.replace(/\\(["\\/])/g, '$1').replace(/\\n/g, '\n') : ''
      const n = /"n_ctx"\s*:\s*(\d+)\s*[,}]/.exec(raw)
      nCtx = n ? num(n[1]) : null
    }
  }
  let prev = ''
  while (prev !== text) {
    prev = text
    text = text.replace(/"[^"]*"|`[^`]*`|“[^”]*”/g, ' ').replace(/\{[^{}]*\}|\[[^[\]]*\]/g, ' ')
  }
  return { text, nCtx }
}

/** The context size a provider's refusal names, or null. Only the providers' own sentences, anchored: "This model's
 * maximum context length is 8192 tokens" (OpenAI, vLLM), "exceeds the available context size (8192 tokens)"
 * (llama.cpp, with its n_ctx field), "the model is loaded with context length of only 4096 tokens" (LM Studio). */
export function contextFromRefusal(body: string): number | null {
  const { text, nCtx } = refusalWords(body)
  if (nCtx) return nCtx
  const pats = [
    /\bmaximum context length is (\d[\d,]*) tokens\b/i,
    /\brequest exceeds the available context size \((\d+) tokens\)/i,
    /\bthe model is loaded with context length of only (\d+) tokens\b/i,
  ]
  for (const p of pats) {
    const m = p.exec(text)
    const n = m ? num(m[1]!.replace(/,/g, '')) : null
    if (n) return n
  }
  return null
}

/** A refusal for a too-long request: what it says about the model's size is kept for the next turns. */
export function noteContextRefusal(conf: Pick<ApiEngineConf, 'baseUrl' | 'model'>, body: string, now = Date.now()): number | null {
  const n = contextFromRefusal(body)
  if (n) refused.set(keyOf(conf), { tokens: n, at: now })
  return n
}

/** A request that went through with `promptTokens`: a refusal's number below that was wrong, and is forgotten. */
export function noteContextUsage(conf: Pick<ApiEngineConf, 'baseUrl' | 'model'>, promptTokens: unknown) {
  const k = keyOf(conf)
  const r = refused.get(k)
  if (r && typeof promptTokens === 'number' && promptTokens > r.tokens) refused.delete(k)
}

/** `long`: may take until the look-up's own limit (PROBES_TIMEOUT_MS), not only PROBE_TIMEOUT_MS (loading a model) */
type Get = (url: string, init?: RequestInit, o?: { long?: boolean }) => Promise<unknown | null>

/** The size a model entry of an OpenAI-compatible /models list (or one model's own entry) states. */
function fromModelEntry(m: any): number | null {
  if (!m || typeof m !== 'object') return null
  return num(m.loaded_context_length) ?? num(m.max_model_len) ?? num(m.context_length) ?? num(m.context_window)
    ?? num(m.max_context_length) ?? num(m.top_provider?.context_length) ?? num(m.meta?.n_ctx) ?? num(m.meta?.n_ctx_train)
}

/** What the model's server says, in order: the size it runs with now, then a stated one. */
async function probe(conf: ApiEngineConf, get: Get): Promise<ContextSize | null> {
  let origin: string
  try { origin = new URL(conf.baseUrl).origin } catch { return null }
  const local = isLocalApiAddress(conf.baseUrl)
  const same = (a: unknown) => typeof a === 'string' && (a === conf.model || a.replace(/:latest$/, '') === conf.model.replace(/:latest$/, ''))
  // Ollama: a loaded model says the size it runs with (/api/ps context_length); else its num_ctx parameter (in
  // /api/show also before it is loaded). Without num_ctx a model loads with the server's default
  // (OLLAMA_CONTEXT_LENGTH, which no API shows): 4096 when not set, 2048 before 0.6. That default, at most the
  // trained length, is the guess (QA TC-5087: a 32k guess let Ollama cut every prompt of a 16k server until the
  // model was loaded). Once loaded, /api/ps says the real size (a guess is cached only GUESS_CACHE_MS).
  const ps = await get(`${origin}/api/ps`) as any
  const loaded = Array.isArray(ps?.models) ? ps.models.find((m: any) => same(m?.name) || same(m?.model)) : null
  if (num(loaded?.context_length)) return { tokens: num(loaded.context_length)!, exact: true, source: 'ollama' }
  if (Array.isArray(ps?.models)) {
    const show = await get(`${origin}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: conf.model }) }) as any
    const param = typeof show?.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters) : null
    if (param && num(param[1])) return { tokens: num(param[1])!, exact: true, source: 'ollama' }
    // no num_ctx: load the model now (an empty generate, kept loaded for the turn that follows) and read the size it
    // loaded with, so a server with a large OLLAMA_CONTEXT_LENGTH is not taken for a 4096 one. A load that does not
    // finish within the look-up's limit leaves the guess below
    const warm = await get(`${origin}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: conf.model, keep_alive: OLLAMA_KEEP_ALIVE, stream: false }) }, { long: true })
    if (warm) {
      const after = await get(`${origin}/api/ps`) as any
      const now = Array.isArray(after?.models) ? after.models.find((m: any) => same(m?.name) || same(m?.model)) : null
      if (num(now?.context_length)) return { tokens: num(now.context_length)!, exact: true, source: 'ollama' }
    }
    const trained = show?.model_info && typeof show.model_info === 'object' ? Object.entries(show.model_info).find(([k]) => k.endsWith('.context_length'))?.[1] : null
    const version = await get(`${origin}/api/version`) as any
    const old = typeof version?.version === 'string' && /^0\.[0-5]\./.test(version.version)
    const fallback = old ? OLLAMA_OLD_DEFAULT_TOKENS : OLLAMA_DEFAULT_TOKENS
    return { tokens: Math.min(num(trained) ?? fallback, fallback), exact: false, source: 'ollama' }
  }
  // LM Studio: the loaded size, else what it loads a model with unless told (4096), at most the model's own most
  const lms = await get(`${origin}/api/v0/models/${encodeURIComponent(conf.model)}`) as any
  if (lms && typeof lms === 'object' && (lms.loaded_context_length !== undefined || lms.max_context_length !== undefined)) {
    if (lms.state === 'loaded' && num(lms.loaded_context_length)) return { tokens: num(lms.loaded_context_length)!, exact: true, source: 'lmstudio' }
    const most = num(lms.max_context_length)
    if (most) return { tokens: Math.min(most, LMSTUDIO_DEFAULT_TOKENS), exact: false, source: 'lmstudio' }
  }
  // llama.cpp's server: the size each request may use
  if (local) {
    const props = await get(`${origin}/props`) as any
    const n = num(props?.default_generation_settings?.n_ctx) ?? num(props?.n_ctx)
    if (n) return { tokens: n, exact: true, source: 'llamacpp' }
  }
  // any OpenAI-compatible list that states it (OpenRouter, vLLM, Groq, Together, LM Studio's list, llama.cpp's meta)
  const list = await get(`${conf.baseUrl}/models`, conf.key ? { headers: { Authorization: `Bearer ${conf.key}` } } : undefined) as any
  const entries: any[] = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : []
  const entry = entries.find((m) => same(m?.id) || same(m?.name) || same(m?.model))
  const stated = fromModelEntry(entry)
  if (stated) return { tokens: stated, exact: true, source: 'models' }
  return local ? { tokens: LOCAL_GUESS_TOKENS, exact: false, source: 'local-guess' } : null
}

/**
 * The context size of the team's API model, or null when nothing is known (a cloud model that does not say: the
 * window stays as for the other engines). A refusal's number wins over a probe when smaller. Probes are cached per
 * address and model, and one runs at a time.
 */
export async function apiContextSize(conf: ApiEngineConf, o: { fetchFn?: typeof fetch; now?: number; signal?: AbortSignal } = {}): Promise<ContextSize | null> {
  const now = o.now ?? Date.now()
  const k = keyOf(conf)
  const ref = refused.get(k)
  if (ref && now - ref.at >= REFUSAL_CACHE_MS) refused.delete(k)
  // never exact: the refusal's text is not the server's own statement of its size
  const fromRefusal: ContextSize | null = ref && now - ref.at < REFUSAL_CACHE_MS ? { tokens: ref.tokens, exact: false, source: 'refusal' } : null
  let size: ContextSize | null
  const hit = probed.get(k)
  const missFor = isLocalApiAddress(conf.baseUrl) ? LOCAL_MISS_CACHE_MS : CONTEXT_CACHE_MS
  if (hit && now - hit.at < (hit.size ? (hit.size.exact ? CONTEXT_CACHE_MS : GUESS_CACHE_MS) : missFor)) size = hit.size
  else {
    let p = inflight.get(k)
    if (!p) {
      const f = apiEngineFetch(o.fetchFn ?? fetch, { publicCheck: conf.setBy === 'admin' })
      const all = AbortSignal.timeout(PROBES_TIMEOUT_MS)
      const get: Get = async (url, init, g) => {
        try {
          const r = await f(url, { ...init, signal: g?.long ? all : AbortSignal.any([all, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) })
          if (!r.ok || !r.body) return null
          return await boundedJson(r)
        } catch { return null }
      }
      p = probe(conf, get).catch(() => null).finally(() => inflight.delete(k))
      // what this look-up learned, for every turn (one that stopped waiting included)
      p.then((v) => probed.set(k, { size: v, at: now }))
      inflight.set(k, p)
    }
    // the turn's Stop ends the wait at once (the probe goes on and its answer is kept)
    const stopped = o.signal ? new Promise<'stopped'>((r) => { if (o.signal!.aborted) r('stopped'); else o.signal!.addEventListener('abort', () => r('stopped'), { once: true }) }) : null
    const got = await (stopped ? Promise.race([p, stopped]) : p)
    if (got === 'stopped') return null
    size = got
  }
  if (fromRefusal && (!size || fromRefusal.tokens < size.tokens)) return fromRefusal
  return size
}

/** A probe's JSON, read only up to PROBE_BODY_MAX bytes (null when larger or not JSON). */
async function boundedJson(r: Response): Promise<unknown | null> {
  const len = Number(r.headers.get('content-length') ?? '')
  if (Number.isFinite(len) && len > PROBE_BODY_MAX) { await r.body?.cancel().catch(() => {}); return null }
  const reader = r.body!.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > PROBE_BODY_MAX) { await reader.cancel().catch(() => {}); return null }
    parts.push(value)
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(parts))) } catch { return null }
}

/** A guess that says nothing about the model: a cloud address, or a local one that is not Ollama or LM Studio (a
 * LiteLLM proxy at http://litellm:4000 in front of a 200k model). It neither cuts the tool list nor shrinks the
 * history when the tools alone fill it (chat/turn.ts). Ollama's and LM Studio's own guess (a model not loaded yet:
 * their default load size) does both, or Ollama cuts the prompt's start (QA TC-5087). */
export function blindGuess(size: ContextSize, baseUrl: string): boolean {
  if (size.exact || size.source === 'refusal') return false
  return !(isLocalApiAddress(baseUrl) && (size.source === 'ollama' || size.source === 'lmstudio'))
}

/** tests: forget what was learned */
export function resetApiContextForTests() { probed.clear(); refused.clear(); inflight.clear() }
