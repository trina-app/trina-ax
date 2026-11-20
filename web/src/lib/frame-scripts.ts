// Team script files in HTML previews and artifacts (docs/decisions/20261120-team-scripts-in-previews.md): the frame's
// CSP stays as it is (script-src 'unsafe-inline' data: blob: and this server's /vendor/; lib/artifacts.ts): nothing
// in the page can load a script from the team folder or the web. Before the page goes into the frame, this step
// (called by lib/frame-files.ts resolveFrameFiles, only for a frame that runs scripts) puts each team script file that
// the page names into the page itself, fetched with the person's own permissions and the same `embedIn` rule as the
// images (server/src/team-files/embed.ts). So `<script src="lib/three.min.js">` next to warehouse/index.html runs the
// team file warehouse/lib/three.min.js, like a browser opening the folder would.
//
// - Classic scripts: `<script src>` with a team path gets the file as a data: URL (`src` stays an external script for
//   the browser: same order, same defer / async).
// - Modules: `<script type="module">` (inline, or src: it becomes an inline module that imports the file's key, so a
//   module is one copy however many import it), its static and dynamic imports, and bare names (`import
//   "three"`) through the page's own import map (`imports` only). A data: module cannot resolve a relative import
//   (a data: URL is no base), so every import of a team module is rewritten to the key `mycel-file:/<path>`
//   (es-module-lexer finds the specifiers; strings, comments, template text and regexes are skipped), and one import
//   map that this step writes first in <head> maps each key to the module as a data: URL. The page's own import map is
//   removed (a browser takes only one before the first module, older Safari only one at all). Cycles work: a key does
//   not depend on the module's text.
// - Paths: lib/frame-files.ts classifyRef (relative to the HTML file's folder, "/" from the team root, never above
//   it). Only .js, .mjs and .cjs files, at most FRAME_SCRIPTS_MAX different files and FRAME_SCRIPTS_BYTES together
//   (separate from the image caps).
// - A web script (http(s):, //host) is counted for the note above the frame. A classic one becomes a script that throws
//   an error which names it (so the frame does not even ask for it); a web module import (also through the import
//   map) stays an address, which the frame's CSP blocks and the page reports, as before.
// - A team script that is missing, not allowed, not a script file or over the cap is counted by name for the same
//   note; a classic one becomes a script that throws an error which names it, a module import of it stays unresolved
//   (the browser's error names the key).
//
// Not covered: scripts that a running page makes itself (document.createElement('script')), import map scopes and
// integrity, and import map keys that are not bare names.
import { parse as lexModule } from 'es-module-lexer/minimal/js'
import { classifyRef, type Ref } from './frame-files'

export const FRAME_SCRIPTS_MAX = 100
export const FRAME_SCRIPTS_BYTES = 5 * 1024 * 1024
/** the import map key scheme of a team module (never a real address: an unmapped key loads nothing) */
export const MODULE_SCHEME = 'mycel-file:'
/** files fetched at the same time */
const PARALLEL = 4

const SCRIPT_FILE = /\.(m?js|cjs)$/i
/** `type` values that make a classic script (HTML's JavaScript MIME type essence list, and none) */
const CLASSIC_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'application/ecmascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript'])

/** The import map key of a team module: each path segment %-escaped (also "'"), so a key has no quote or backslash
 * and can replace the text inside any string quotes. */
export function moduleKey(path: string): string {
  return MODULE_SCHEME + '/' + path.split('/').map((seg) => encodeURIComponent(seg).replace(/'/g, '%27')).join('/')
}

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** A bare name through the page's import map (`imports`: an exact key, else the longest key ending in "/" that the name
 * starts with); null when the map does not name it. */
export function mapBare(spec: string, imports: Record<string, string>): string | null {
  if (Object.hasOwn(imports, spec)) return imports[spec]!
  let best: string | null = null
  for (const k of Object.keys(imports)) if (k.endsWith('/') && spec.startsWith(k) && (best === null || k.length > best.length)) best = k
  return best === null ? null : imports[best]! + spec.slice(best.length)
}

/** What a module specifier points at. `from`: the team folder of the importing module (the page's for an inline one);
 * `pageFolder`: where the import map's addresses are resolved. */
export function classifySpecifier(spec: string, from: string, pageFolder: string, imports: Record<string, string>): Ref {
  if (/^(\.{0,2})\//.test(spec)) return classifyRef(spec, from)
  if (/^https?:/i.test(spec) || spec.startsWith('//')) return { kind: 'external' }
  if (/^(data|blob):/i.test(spec)) return { kind: 'keep' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return { kind: 'blocked' }
  const mapped = mapBare(spec, imports)
  if (mapped === null) return { kind: 'blocked' }
  if (/^https?:/i.test(mapped) || mapped.startsWith('//')) return { kind: 'external' }
  return classifyRef(mapped, pageFolder)
}

function utf8Base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
const jsDataUrl = (bytes: Uint8Array) => `data:text/javascript;charset=utf-8;base64,${utf8Base64(bytes)}`
const jsText = (text: string) => jsDataUrl(new TextEncoder().encode(text))

/** A classic script in place of one that could not be put in: it throws an error that names the file (the frame
 * reports a page's errors). */
export const missingScript = (name: string) => jsText(`throw new Error(${JSON.stringify(`Team script not loaded: ${name}`)})`)
/** A classic script in place of a web one: the frame never asks for it; the error says what to do instead. */
export const webScript = (url: string) =>
  jsText(`throw new Error(${JSON.stringify(`Web script blocked in the preview: ${url}. Save the library as a team file next to the page and use a relative path.`)})`)

/** A module's text with each import specifier replaced (`swap` returns null to keep one). */
export function rewriteImports(source: string, swap: (spec: string) => string | null): string {
  let imports: ReturnType<typeof lexModule>[0]
  try { imports = lexModule(source)[0] } catch { return source }
  let out = ''
  let at = 0
  for (const im of imports) {
    if (im.n === undefined || im.d === -2) continue
    const to = swap(im.n)
    if (to === null) continue
    // a static import's s..e is the text inside the quotes; a dynamic one's is the whole argument, quotes included
    const dynamic = im.d > -1
    out += source.slice(at, im.s) + (dynamic ? JSON.stringify(to) : to)
    at = im.e
  }
  return at === 0 ? source : out + source.slice(at)
}

export interface FrameScriptsOptions {
  folder: string | null
  signal?: AbortSignal
  fetchFile: (path: string, max: number, signal?: AbortSignal) => Promise<Blob>
}

export interface FrameScripts {
  /** whether the document was changed */
  changed: boolean
  /** different web scripts that do not run (for the note) */
  external: number
  /** team script files that could not be put in, by path or as written (for the note) */
  missing: string[]
}

type ScriptEl = Element & { textContent: string | null }

/** Put the team scripts of a parsed page into it, in place (see the header). */
export async function resolveFrameScripts(doc: Document, o: FrameScriptsOptions): Promise<FrameScripts> {
  const scripts = (Array.from(doc.querySelectorAll('script')) as ScriptEl[]).filter((el) => el.namespaceURI !== 'http://www.w3.org/2000/svg')
  if (!scripts.length) return { changed: false, external: 0, missing: [] }
  const pageFolder = o.folder
  const external = new Set<string>()
  const missing = new Set<string>()
  let changed = false

  // the page's import map: its `imports` (later maps add to earlier ones); every map is removed
  const imports: Record<string, string> = {}
  const classic: ScriptEl[] = []
  const modules: ScriptEl[] = []
  for (const el of scripts) {
    const type = (el.getAttribute('type') ?? '').trim().toLowerCase()
    if (type === 'importmap') {
      try {
        const m = JSON.parse(el.textContent ?? '') as { imports?: Record<string, unknown> }
        for (const [k, v] of Object.entries(m?.imports ?? {})) if (typeof v === 'string' && !/^(\.{0,2})\/|^[a-z][a-z0-9+.-]*:/i.test(k)) imports[k] = v
      } catch {}
      el.remove()
      changed = true
    } else if (type === 'module') modules.push(el)
    else if (CLASSIC_TYPES.has(type)) classic.push(el)
  }

  // what to fetch: classic sources, module sources, and the module graph as it is read
  const texts = new Map<string, Uint8Array | null>() // team path -> bytes (null: could not be put in)
  const isModule = new Set<string>()
  const queue: string[] = []
  const want = (path: string, module: boolean) => {
    if (module) isModule.add(path)
    if (texts.has(path)) return
    texts.set(path, null)
    if (!SCRIPT_FILE.test(path) || texts.size > FRAME_SCRIPTS_MAX || pageFolder === null) missing.add(path)
    else queue.push(path)
  }
  const note = (raw: string, r: Ref) => {
    if (r.kind === 'external') external.add(raw.trim())
    else if (r.kind === 'blocked') missing.add(raw.trim())
  }
  const srcOf = (el: ScriptEl) => Array.from(el.attributes).find((a) => a.name.toLowerCase() === 'src')
  for (const el of [...classic, ...modules]) {
    const a = srcOf(el)
    if (!a) continue
    const r = classifyRef(a.value, pageFolder)
    note(a.value, r)
    if (r.kind === 'team') want(r.path, modules.includes(el))
  }
  // inline modules: their imports, resolved against the page's folder
  const specRefs = (source: string, from: string): { spec: string; r: Ref }[] => {
    let list: ReturnType<typeof lexModule>[0]
    try { list = lexModule(source)[0] } catch { return [] }
    return list.filter((im) => im.n !== undefined && im.d !== -2).map((im) => ({ spec: im.n!, r: classifySpecifier(im.n!, from, pageFolder ?? '', imports) }))
  }
  const decoder = new TextDecoder()
  const follow = (source: string, from: string) => {
    for (const { spec, r } of specRefs(source, from)) {
      note(spec, r)
      if (r.kind === 'team') want(r.path, true)
    }
  }
  if (pageFolder !== null) for (const el of modules) if (!srcOf(el)) follow(el.textContent ?? '', pageFolder)

  let total = 0
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift()!
      o.signal?.throwIfAborted()
      try {
        const blob = await o.fetchFile(p, Math.max(0, FRAME_SCRIPTS_BYTES - total), o.signal)
        if (total + blob.size > FRAME_SCRIPTS_BYTES) { missing.add(p); continue }
        total += blob.size
        const bytes = new Uint8Array(await blob.arrayBuffer())
        texts.set(p, bytes)
        if (isModule.has(p)) follow(decoder.decode(bytes), folderOf(p))
      } catch (e) {
        if (o.signal?.aborted) throw e
        missing.add(p)
      }
    }
  }
  // workers end when the queue is empty; a module read later can add more, so run rounds until nothing is left
  while (queue.length) await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker))
  o.signal?.throwIfAborted()

  // a module's text with its team imports as keys (a web or unknown import stays as written: CSP or the browser
  // refuses it and the page reports it; a web one named through the import map becomes that address)
  const rewrite = (source: string, from: string) => rewriteImports(source, (spec) => {
    const r = classifySpecifier(spec, from, pageFolder ?? '', imports)
    if (r.kind === 'team') return moduleKey(r.path)
    if (r.kind === 'external' && !/^https?:|^\/\//i.test(spec)) return mapBare(spec, imports)
    return null
  })
  const map: Record<string, string> = {}
  for (const p of isModule) {
    const bytes = texts.get(p)
    if (bytes) map[moduleKey(p)] = jsText(rewrite(decoder.decode(bytes), folderOf(p)))
  }

  for (const el of classic) {
    const a = srcOf(el)
    if (!a) continue
    const r = classifyRef(a.value, pageFolder)
    if (r.kind === 'external') { a.value = webScript(a.value.trim()); changed = true; continue }
    if (r.kind !== 'team' && r.kind !== 'blocked') continue
    const bytes = r.kind === 'team' ? texts.get(r.path) : null
    a.value = bytes ? jsDataUrl(bytes) : missingScript(r.kind === 'team' ? r.path : a.value.trim())
    changed = true
  }
  for (const el of modules) {
    const a = srcOf(el)
    if (!a) {
      if (pageFolder === null) continue
      const before = el.textContent ?? ''
      const after = rewrite(before, pageFolder)
      if (after !== before) { el.textContent = after; changed = true }
      continue
    }
    const r = classifyRef(a.value, pageFolder)
    if (r.kind !== 'team' && r.kind !== 'blocked') continue
    // an inline module that imports the key (a <script src> takes no import map key, and a data: URL of its own
    // would be a second copy of a module that another one imports too); one that is not there throws its name
    if (r.kind === 'team' && map[moduleKey(r.path)]) {
      el.removeAttributeNode(a)
      el.textContent = `import ${JSON.stringify(moduleKey(r.path))};`
    } else a.value = missingScript(r.kind === 'team' ? r.path : a.value.trim())
    changed = true
  }
  if (Object.keys(map).length) {
    const el = doc.createElement('script')
    el.setAttribute('type', 'importmap')
    // JSON inside a <script>: "<" escaped, so no "</script" or "<!--" can end it early
    el.textContent = JSON.stringify({ imports: map }).replace(/</g, '\\u003c')
    const head = doc.head ?? doc.documentElement
    head.prepend(el)
    changed = true
  }
  return { changed, external: external.size, missing: [...missing] }
}
