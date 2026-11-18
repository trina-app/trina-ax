// How much the API engine's model can read at once (its context window, in tokens), so a chat's history, the
// instructions and the tool list are fitted into it (docs/decisions/20261118-history-small-models.md). A local model
// (Ollama, LM Studio, llama.cpp) often runs with 4k-32k tokens: the history window made for Claude (40k tokens) alone
// overflowed it. Ollama does not even refuse: it cuts the start of the prompt, and the instructions went first.
//
// Learned, never set by hand: what the model's own server says (Ollama /api/ps and /api/show, LM Studio
// /api/v0/models, llama.cpp /props, the OpenAI-compatible model list: OpenRouter, vLLM, Groq, Together …), or the
// number a refusal named ("maximum context length is 8192 tokens"). `exact`: the size the model really runs with now;
// a guess (a local address that said nothing, a model loaded later) only shrinks the window, it never refuses a turn.
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
/** a probe's answer is kept this long (a model loaded with another size is seen at most this late) */
export const CONTEXT_CACHE_MS = 10 * 60_000
/** a probe that learned nothing is not repeated for this long */
const MISS_CACHE_MS = 60_000
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

/** The context size a provider's refusal names, or null ("maximum context length is 8192 tokens" OpenAI / vLLM,
 * "available context size (8192 tokens)" llama.cpp, "context length of only 4096 tokens" LM Studio, "n_ctx: 4096"). */
export function contextFromRefusal(body: string): number | null {
  const pats = [
    /maximum context length (?:is|of) (\d[\d,]*)/i,
    /context (?:size|length|window)[^\d\n]{0,40}?(?:of|is|\()\s*(?:only\s+)?(\d[\d,]*)\s*tokens/i,
    /context[_ ]length[^\d\n]{0,10}(\d[\d,]*)/i,
    /\bn_ctx(?:_slot)?["']?\s*[:=]\s*(\d+)/i,
  ]
  for (const p of pats) {
    const m = p.exec(body)
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

type Get = (url: string, init?: RequestInit) => Promise<unknown | null>

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
  // Ollama: a loaded model says the size it runs with (/api/ps context_length); else its num_ctx parameter. Its
  // trained length is not what it runs with (Ollama starts it smaller unless told), so it is a guess only.
  const ps = await get(`${origin}/api/ps`) as any
  const loaded = Array.isArray(ps?.models) ? ps.models.find((m: any) => same(m?.name) || same(m?.model)) : null
  if (num(loaded?.context_length)) return { tokens: num(loaded.context_length)!, exact: true, source: 'ollama' }
  if (Array.isArray(ps?.models)) {
    const show = await get(`${origin}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: conf.model }) }) as any
    const param = typeof show?.parameters === 'string' ? /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters) : null
    if (param && num(param[1])) return { tokens: num(param[1])!, exact: true, source: 'ollama' }
    const trained = show?.model_info && typeof show.model_info === 'object' ? Object.entries(show.model_info).find(([k]) => k.endsWith('.context_length'))?.[1] : null
    return { tokens: Math.min(num(trained) ?? LOCAL_GUESS_TOKENS, LOCAL_GUESS_TOKENS), exact: false, source: 'ollama' }
  }
  // LM Studio: the loaded size, else the most the model can take (it loads with a smaller one unless told: a guess)
  const lms = await get(`${origin}/api/v0/models/${encodeURIComponent(conf.model)}`) as any
  if (lms && typeof lms === 'object' && (lms.loaded_context_length !== undefined || lms.max_context_length !== undefined)) {
    if (lms.state === 'loaded' && num(lms.loaded_context_length)) return { tokens: num(lms.loaded_context_length)!, exact: true, source: 'lmstudio' }
    const most = num(lms.max_context_length)
    if (most) return { tokens: Math.min(most, LOCAL_GUESS_TOKENS), exact: false, source: 'lmstudio' }
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
export async function apiContextSize(conf: ApiEngineConf, o: { fetchFn?: typeof fetch; now?: number } = {}): Promise<ContextSize | null> {
  const now = o.now ?? Date.now()
  const k = keyOf(conf)
  const ref = refused.get(k)
  const fromRefusal: ContextSize | null = ref && now - ref.at < REFUSAL_CACHE_MS ? { tokens: ref.tokens, exact: true, source: 'refusal' } : null
  let size: ContextSize | null
  const hit = probed.get(k)
  if (hit && now - hit.at < (hit.size ? CONTEXT_CACHE_MS : MISS_CACHE_MS)) size = hit.size
  else {
    let p = inflight.get(k)
    if (!p) {
      const f = apiEngineFetch(o.fetchFn ?? fetch, { publicCheck: conf.setBy === 'admin' })
      const get: Get = async (url, init) => {
        try {
          const r = await f(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
          if (!r.ok) return null
          return await r.json()
        } catch { return null }
      }
      p = probe(conf, get).catch(() => null).finally(() => inflight.delete(k))
      inflight.set(k, p)
    }
    size = await p
    probed.set(k, { size, at: now })
  }
  if (fromRefusal && (!size || fromRefusal.tokens < size.tokens || !size.exact)) return fromRefusal
  return size
}

/** tests: forget what was learned */
export function resetApiContextForTests() { probed.clear(); refused.clear(); inflight.clear() }
