// Does the team's API engine model take pictures? (docs/decisions/20261118-api-images-connector-cap-delete-cards.md)
// Claude Code shows the model every picture a read gives; the API engine (engine/api-agent.ts) sent text only. A model
// that takes images now gets them; whether it does is learned from what the model's own server says, never guessed
// from its name, except for the official OpenAI, Gemini and Anthropic endpoints, whose current chat models all take
// images:
//   - an OpenAI-compatible model list that says it (OpenRouter `architecture.input_modalities`, and the same field or
//     `capabilities.vision` / `supports_vision` on other lists);
//   - Ollama /api/show `capabilities` ("vision"; an older Ollama: a vision projector in its answer), asked only after
//     GET /api/version answered as Ollama;
//   - LM Studio /api/v0/models/<id> `type` ("vlm" or "llm");
//   - llama.cpp's /props `modalities.vision` (an address on this computer or the local network only).
// Nothing said: unknown. Then the admin's choice in the API engine form counts ("Reads pictures": yes or no, stored in
// engine-api.json `vision`); with no choice, text only as before. The choice is never used when the server says.
//
// The probes go through the same address check as the turns (system/egress.ts apiEngineFetch). The key goes only to
// the address it was saved for (the /models list), never to the other paths of that host.
import type { ApiEngineConf } from './api-agent'
import { apiEngineFetch } from '../system/egress'
import { isLocalAddress, isPublicAddress } from '../tools/web-fetch'

export type VisionSource = 'name' | 'models' | 'ollama' | 'lmstudio' | 'llamacpp'
export interface ApiVision { images: boolean | null; source: VisionSource | null }

/** a probe's answer is kept this long */
export const VISION_CACHE_MS = 10 * 60_000
/** a look-up that learned nothing at a local address is repeated sooner (a model still loading) */
const LOCAL_MISS_CACHE_MS = 60_000
/** all probes of one look-up together: a turn waits at most this long */
const PROBES_TIMEOUT_MS = 5_000
const PROBE_TIMEOUT_MS = 3_000
/** a probe's answer larger than this is not read (OpenRouter's model list is about 500 kB) */
export const PROBE_BODY_MAX = 2_000_000

const keyOf = (c: Pick<ApiEngineConf, 'baseUrl' | 'model'>) => `${c.baseUrl}\0${c.model}`
const probed = new Map<string, { v: ApiVision; at: number }>()
const inflight = new Map<string, Promise<ApiVision>>()

/** The address is on this computer or the local network (localhost, a private IP, a .local / .lan name, one label). */
export function isLocalApiHost(baseUrl: string): boolean {
  let host: string
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '') } catch { return false }
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(local|lan|internal|home\.arpa)$/.test(host)) return true
  if (/^[\d.]+$/.test(host) || host.includes(':')) return !isPublicAddress(host) || isLocalAddress(host)
  return !host.includes('.')
}

/** The official endpoints whose chat models take images, by the model's name (no network). null: not one of them, or a
 * name it does not know. */
export function visionByName(baseUrl: string, model: string): boolean | null {
  let host: string
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { return null }
  const m = model.toLowerCase().replace(/^models\//, '')
  if (host === 'api.openai.com') {
    if (/^(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4\.5|gpt-5|chatgpt-4o|o3(?!-mini)|o4)/.test(m) || /^o1(-\d{4}-\d{2}-\d{2})?$/.test(m)) return true
    if (/^(gpt-3\.5|o1-mini|o3-mini|gpt-4(-\d{4})?$)/.test(m)) return false
    return null
  }
  if (host === 'generativelanguage.googleapis.com') return /^gemini-/.test(m) && !/embedding/.test(m) ? true : null
  if (host === 'api.anthropic.com') return /^claude-(3|sonnet|opus|haiku)/.test(m) ? true : null
  return null
}

const asList = (x: unknown): string[] | null => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : null)

/** What a model list entry says about images, or null. */
export function visionOfModelEntry(m: unknown): boolean | null {
  if (!m || typeof m !== 'object') return null
  const e = m as Record<string, any>
  const inputs = asList(e.architecture?.input_modalities) ?? asList(e.input_modalities) ?? asList(e.modalities?.input) ?? asList(e.modalities)
  if (inputs) return inputs.includes('image')
  if (typeof e.capabilities?.vision === 'boolean') return e.capabilities.vision
  const caps = asList(e.capabilities)
  if (caps) return caps.includes('vision')
  if (typeof e.supports_vision === 'boolean') return e.supports_vision
  if (typeof e.architecture?.modality === 'string') return /image.*->/.test(e.architecture.modality) || /\+image/.test(e.architecture.modality) ? true : /^text->/.test(e.architecture.modality) ? false : null
  return null
}

/** What Ollama's /api/show says: its capabilities, or (an older Ollama) a vision projector. null: not Ollama's answer. */
export function visionOfOllamaShow(show: unknown): boolean | null {
  if (!show || typeof show !== 'object') return null
  const s = show as Record<string, any>
  const caps = asList(s.capabilities)
  if (caps) return caps.includes('vision')
  if (!s.model_info && !s.details) return null
  if (s.projector_info && typeof s.projector_info === 'object') return true
  const fam = asList(s.details?.families) ?? []
  return fam.some((f) => f === 'clip' || f === 'mllama')
}

type Get = (url: string, init?: RequestInit) => Promise<unknown | null>

async function probe(conf: ApiEngineConf, get: Get): Promise<ApiVision> {
  const named = visionByName(conf.baseUrl, conf.model)
  if (named !== null) return { images: named, source: 'name' }
  let origin: string
  try { origin = new URL(conf.baseUrl).origin } catch { return { images: null, source: null } }
  const same = (a: unknown) => typeof a === 'string' && (a === conf.model || a.replace(/:latest$/, '') === conf.model.replace(/:latest$/, ''))
  // the OpenAI-compatible list (OpenRouter and others state the inputs a model takes)
  const list = await get(`${conf.baseUrl}/models`, conf.key ? { headers: { Authorization: `Bearer ${conf.key}` } } : undefined) as any
  const entries: any[] = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : []
  const listed = visionOfModelEntry(entries.find((m) => same(m?.id) || same(m?.name) || same(m?.model)))
  if (listed !== null) return { images: listed, source: 'models' }
  // Ollama: asked with a POST only once its GET /api/version answered as Ollama does (no POST to another server)
  const version = await get(`${origin}/api/version`) as any
  if (version && typeof version === 'object' && typeof version.version === 'string') {
    const show = await get(`${origin}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: conf.model }) })
    const ollama = visionOfOllamaShow(show)
    if (ollama !== null) return { images: ollama, source: 'ollama' }
  }
  // LM Studio
  const lms = await get(`${origin}/api/v0/models/${encodeURIComponent(conf.model)}`) as any
  if (lms && typeof lms === 'object' && typeof lms.type === 'string' && (lms.type === 'vlm' || lms.type === 'llm')) return { images: lms.type === 'vlm', source: 'lmstudio' }
  // llama.cpp's own server
  if (isLocalApiHost(conf.baseUrl)) {
    const props = await get(`${origin}/props`) as any
    if (typeof props?.modalities?.vision === 'boolean') return { images: props.modalities.vision, source: 'llamacpp' }
  }
  return { images: null, source: null }
}

/**
 * What the model's server says about images (cached per address and model; one look-up at a time). The turn's Stop
 * ends the wait (the look-up goes on and its answer is kept).
 */
export async function apiVisionOf(conf: ApiEngineConf, o: { fetchFn?: typeof fetch; now?: number; signal?: AbortSignal } = {}): Promise<ApiVision> {
  const now = o.now ?? Date.now()
  const k = keyOf(conf)
  const hit = probed.get(k)
  const missFor = isLocalApiHost(conf.baseUrl) ? LOCAL_MISS_CACHE_MS : VISION_CACHE_MS
  if (hit && now - hit.at < (hit.v.images !== null ? VISION_CACHE_MS : missFor)) return hit.v
  let p = inflight.get(k)
  if (!p) {
    const f = apiEngineFetch(o.fetchFn ?? fetch, { publicCheck: conf.setBy === 'admin' })
    const all = AbortSignal.timeout(PROBES_TIMEOUT_MS)
    const get: Get = async (url, init) => {
      try {
        const r = await f(url, { ...init, signal: AbortSignal.any([all, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) })
        if (!r.ok || !r.body) { await r.body?.cancel().catch(() => {}); return null }
        return await boundedJson(r)
      } catch { return null }
    }
    p = probe(conf, get).catch((): ApiVision => ({ images: null, source: null })).finally(() => inflight.delete(k))
    p.then((v) => probed.set(k, { v, at: Date.now() }))
    inflight.set(k, p)
  }
  if (!o.signal) return p
  const stopped = new Promise<ApiVision>((r) => { if (o.signal!.aborted) r({ images: null, source: null }); else o.signal!.addEventListener('abort', () => r({ images: null, source: null }), { once: true }) })
  return Promise.race([p, stopped])
}

/** Whether this turn sends pictures to the model: what its server says, else the admin's choice (conf.vision), else no. */
export async function apiSeesImages(conf: ApiEngineConf, o: Parameters<typeof apiVisionOf>[1] = {}): Promise<{ images: boolean; detected: ApiVision }> {
  const detected = await apiVisionOf(conf, o)
  return { images: detected.images ?? conf.vision === 'on', detected }
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

/** tests: forget what was learned */
export function resetApiVisionForTests() { probed.clear(); inflight.clear() }
