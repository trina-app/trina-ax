// A stand-in for a big MCP tool catalog shaped like Higgsfield's (2026-11: 186 tools in one tools/list page of about
// 1.07 MB): long descriptions and long input schemas with nested objects, enums, a $defs reference and anyOf. The words
// are synthetic. Tool #150 (`video_analysis_create`, read-only) and #151 (`website_publish`, a write) are the ones the
// tests look up and run; the others are `<verb>_<area>_<n>`.

const AREAS = ['image', 'video', 'audio', 'voice', 'project', 'website', 'brand', 'product', 'scene', 'workspace', 'folder', 'preset', 'media', 'job', 'shorts', 'character', 'avatar', 'music']
const VERBS = ['generate', 'list', 'get', 'create', 'update', 'delete', 'upscale', 'publish', 'move', 'rename']
const MODELS = Array.from({ length: 24 }, (_, i) => `studio-model-${String.fromCharCode(97 + (i % 26))}${i}-v${1 + (i % 4)}`)
const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => ['frame', 'colour', 'subject', 'motion', 'light', 'texture', 'camera', 'mood', 'layer', 'timing'][(seed + i * 7) % 10]).join(' ')
const pad = (seed: number, chars: number) => { let s = ''; for (let i = 0; s.length < chars; i++) s += `${words(seed + i, 9)}. `; return s.slice(0, chars).trim() }

/** a long input schema (about 5,000 characters as JSON) */
function schema(i: number, extra: Record<string, unknown> = {}, required: string[] = ['prompt']): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: 4000, description: `What to make. ${pad(i, 420)}` },
      model: { type: 'string', enum: MODELS, description: `Which model runs it. ${pad(i + 1, 260)}` },
      aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'], description: pad(i + 2, 120) },
      quality: { type: 'string', enum: ['basic', 'high', 'ultra'], description: pad(i + 3, 120) },
      count: { type: 'integer', minimum: 1, maximum: 4, description: pad(i + 4, 100) },
      references: { type: 'array', maxItems: 8, items: { $ref: '#/$defs/Reference' }, description: `Media to start from. ${pad(i + 5, 300)}` },
      options: {
        type: 'object', additionalProperties: false, description: pad(i + 6, 200),
        properties: {
          seed: { type: 'integer', minimum: 0, description: pad(i + 7, 120) },
          negative_prompt: { type: 'string', maxLength: 2000, description: pad(i + 8, 300) },
          style: { type: 'string', enum: ['natural', 'cinematic', 'anime', 'studio', 'documentary', 'watercolour'], description: pad(i + 9, 160) },
          duration_seconds: { type: 'number', minimum: 1, maximum: 60, description: pad(i + 10, 140) },
        },
      },
      callback_url: { anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'null' }], description: pad(i + 11, 160) },
      ...extra,
    },
    required,
    additionalProperties: false,
    $defs: {
      Reference: {
        type: 'object',
        properties: {
          media_id: { type: 'string', pattern: '^[a-z0-9-]{8,64}$', description: pad(i + 12, 180) },
          role: { type: 'string', enum: ['subject', 'style', 'start_frame', 'end_frame'], description: pad(i + 13, 140) },
          weight: { type: 'number', minimum: 0, maximum: 1, description: pad(i + 14, 100) },
        },
        required: ['media_id'],
      },
    },
  }
}

export const TOOL_150 = 'video_analysis_create'
export const TOOL_151 = 'website_publish'

/** `n` tools (default 186) as a tools/list page has them */
export function bigCatalog(n = 186): any[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1
    if (i === 150) return {
      name: TOOL_150, title: 'Video analysis',
      description: `Analyze a video's hook, pacing and retention risk, and return a report with the moments viewers are likely to leave. ${pad(i, 700)}`,
      inputSchema: schema(i, { video_url: { type: 'string', maxLength: 2000, description: `The video to analyze. ${pad(i + 20, 200)}` }, focus: { type: 'string', enum: ['hook', 'pacing', 'retention'], description: pad(i + 21, 120) } }, ['video_url']),
      annotations: { readOnlyHint: true },
    }
    if (i === 151) return {
      name: TOOL_151, title: 'Publish a website',
      description: `Publish a website project to its public address so anyone can open it. ${pad(i, 700)}`,
      inputSchema: schema(i, { website_id: { type: 'string', maxLength: 100, description: pad(i + 20, 200) } }, ['website_id']),
    }
    const verb = VERBS[i % VERBS.length]!, area = AREAS[Math.floor(i / VERBS.length) % AREAS.length]!
    return {
      name: `${verb}_${area}_${i}`,
      description: `${verb[0]!.toUpperCase()}${verb.slice(1)} a ${area} (catalog entry ${i}). ${pad(i, 700)}`,
      inputSchema: schema(i),
      ...(verb === 'list' || verb === 'get' ? { annotations: { readOnlyHint: true } } : {}),
    }
  })
}
