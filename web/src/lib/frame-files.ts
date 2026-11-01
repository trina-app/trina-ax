// Team images in HTML / SVG previews and artifacts. The frame's CSP stays as it is (img-src data: blob:, a static view
// img-src data:; lib/artifacts.ts): nothing in the page can load a file. Before the page goes into the frame
// (SandboxFrame) or the static view (StaticFrame), it is parsed here with DOMParser (which runs nothing and loads
// nothing) and every reference to a team image or clip becomes a data: URL of that file, fetched with the person's own
// permissions (fetchFileBlob). So `<img src="images/hero.png">` next to landing/index.html shows the team file
// landing/images/hero.png, like a browser opening the folder would.
//
// - What is looked at: img src / srcset, picture and media source src / srcset, video poster, audio / video src,
//   link rel~=icon href, SVG image href / xlink:href, style attributes and <style> url(…).
// - A relative path is resolved against the HTML file's folder; one starting with "/" against the team root; ?query
//   and #hash are dropped and %-escapes decoded; a path that climbs above the team root is refused.
// - Only image and media files (by extension) are inlined, with the MIME type of their extension: at most
//   FRAME_FILES_MAX different files, FRAME_FILE_BYTES each and FRAME_FILES_BYTES together.
// - An HTML file in the team folder passes itself as `embedIn`: the server gives a file only when everyone who can read
//   the page can read the file too (server/src/team-files/embed.ts), so a script in a shared page never sees a
//   restricted image of the person looking at it. Artifacts have no folder: they resolve against the team root
//   without `embedIn` (only the chat's owner sees them, and their AI worked with the same permissions).
// - A file that is missing, not allowed, too large or not an image / clip shows as a grey placeholder, not a broken
//   picture. Images from the web (http(s):, //host) stay blocked: the same placeholder, counted for the notice above
//   the frame ("ask the AI to save it as a file"). Other addresses (javascript:, file:) become the placeholder too.
//
// Not covered in this version: images a script makes while the page runs (a React artifact's <img>), which never pass
// through here; they stay blocked by the frame's CSP.
import { fetchFileBlob } from './api'

export const FRAME_FILES_MAX = 50
export const FRAME_FILE_BYTES = 10 * 1024 * 1024
export const FRAME_FILES_BYTES = 30 * 1024 * 1024
/** files fetched at the same time */
const PARALLEL = 4

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
}

/** The MIME type a team file is inlined as (by its extension), or null when it is not an image or clip. */
export function mediaMime(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  return m ? MIME[m[1]!.toLowerCase()] ?? null : null
}

/** A neutral grey box with a picture mark, shown instead of a file that cannot be put into the page. */
export const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='120' viewBox='0 0 160 120'><rect width='160' height='120' fill='#e7e5e4'/>" +
  "<circle cx='66' cy='48' r='7' fill='#a8a29e'/><path d='M52 82l18-22 12 14 9-10 17 18z' fill='#a8a29e'/></svg>")

/** What a reference in the page points at. */
export type Ref = { kind: 'team'; path: string } | { kind: 'external' } | { kind: 'blocked' } | { kind: 'keep' }

/** Classify one reference of a page in team folder `folder` ('' = the team root; null = not in the team folder, e.g. a
 * file from this computer: a relative path then points at nothing). */
export function classifyRef(raw: string, folder: string | null): Ref {
  const s = raw.trim()
  if (!s || s.startsWith('#') || /^(data|blob):/i.test(s)) return { kind: 'keep' }
  if (/^https?:/i.test(s) || s.startsWith('//') || s.startsWith('\\\\')) return { kind: 'external' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { kind: 'blocked' }
  if (folder === null) return { kind: 'blocked' }
  let p = s.replace(/[?#].*$/s, '').replace(/\\/g, '/')
  try { p = decodeURIComponent(p) } catch { return { kind: 'blocked' } }
  if (!p || /[\u0000-\u001f]/.test(p)) return { kind: 'blocked' }
  const out = p.startsWith('/') ? [] : folder.split('/').filter(Boolean)
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (!out.length) return { kind: 'blocked' }; out.pop(); continue }
    out.push(seg)
  }
  return out.length ? { kind: 'team', path: out.join('/') } : { kind: 'blocked' }
}

/** The candidates of a srcset (HTML's parsing: a URL runs to whitespace, a comma right after it ends the candidate). */
export function srcsetParts(v: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = []
  let i = 0
  const n = v.length
  while (i < n) {
    while (i < n && (/\s/.test(v[i]!) || v[i] === ',')) i++
    if (i >= n) break
    let j = i
    while (j < n && !/\s/.test(v[j]!)) j++
    let url = v.slice(i, j)
    let descriptor = ''
    if (url.endsWith(',')) url = url.replace(/,+$/, '')
    else {
      let k = j
      let depth = 0
      while (k < n && !(v[k] === ',' && depth === 0)) { if (v[k] === '(') depth++; else if (v[k] === ')') depth = Math.max(0, depth - 1); k++ }
      descriptor = v.slice(j, k).trim()
      j = k
    }
    if (url) out.push({ url, descriptor })
    i = j + 1
  }
  return out
}

const CSS_URL = /url\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|([^)"'\s]*))\s*\)/gi
const cssUnescape = (s: string) => s.replace(/\\(.)/g, '$1')

/** Every url(…) in a piece of CSS. */
export function cssUrls(css: string): string[] {
  return [...css.matchAll(CSS_URL)].map((m) => cssUnescape(m[1] ?? m[2] ?? m[3] ?? ''))
}

/** One place in the page that holds references. */
interface Site { kind: 'url' | 'srcset' | 'css'; get(): string; set(v: string): void; el: Element; attr: string | null }

const SVG_NS = 'http://www.w3.org/2000/svg'
const MEDIA_SRC = new Set(['img', 'source', 'video', 'audio'])

function attrSite(el: Element, name: string, kind: Site['kind']): Site | null {
  const a = Array.from(el.attributes).find((x) => x.name.toLowerCase() === name)
  return a ? { kind, el, attr: a.name, get: () => a.value, set: (v) => { a.value = v } } : null
}

/** The places of a parsed page that can name an image or clip. */
function sitesOf(doc: Document): Site[] {
  const out: Site[] = []
  const add = (s: Site | null) => { if (s) out.push(s) }
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    const tag = el.localName.toLowerCase()
    const svg = el.namespaceURI === SVG_NS
    if (!svg) {
      if (MEDIA_SRC.has(tag)) add(attrSite(el, 'src', 'url'))
      if (tag === 'img' || tag === 'source') add(attrSite(el, 'srcset', 'srcset'))
      if (tag === 'video') add(attrSite(el, 'poster', 'url'))
      if (tag === 'link' && (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/).includes('icon')) add(attrSite(el, 'href', 'url'))
      if (tag === 'style') out.push({ kind: 'css', el, attr: null, get: () => el.textContent ?? '', set: (v) => { el.textContent = v } })
    } else if (tag === 'image' || tag === 'feimage') {
      add(attrSite(el, 'href', 'url'))
      add(attrSite(el, 'xlink:href', 'url'))
    } else if (tag === 'style') out.push({ kind: 'css', el, attr: null, get: () => el.textContent ?? '', set: (v) => { el.textContent = v } })
    add(attrSite(el, 'style', 'css'))
  }
  return out
}

/** The references of one place, in order. */
function refsOf(s: Site): string[] {
  const v = s.get()
  return s.kind === 'url' ? [v] : s.kind === 'srcset' ? srcsetParts(v).map((p) => p.url) : cssUrls(v)
}

/** The place's text with each reference replaced (`swap` returns null to keep one as it is). */
function rewrite(s: Site, swap: (ref: string) => string | null): string {
  const v = s.get()
  if (s.kind === 'url') return swap(v) ?? v
  if (s.kind === 'srcset') return srcsetParts(v).map((p) => [swap(p.url) ?? p.url, p.descriptor].filter(Boolean).join(' ')).join(', ')
  return v.replace(CSS_URL, (all, a?: string, b?: string, c?: string) => {
    const r = swap(cssUnescape(a ?? b ?? c ?? ''))
    return r === null ? all : `url("${r}")`
  })
}

async function dataUrl(blob: Blob, mime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(bin)}`
}

export interface FrameFilesOptions {
  /** the page's team folder ('' = team root); null = not a team file (nothing is fetched) */
  folder: string | null
  /** the HTML file being previewed (the server checks that its readers can read each file) */
  embedIn?: string
  signal?: AbortSignal
  /** tests: how a file is fetched (default fetchFileBlob with the person's session) */
  fetchFile?: (path: string, max: number, signal?: AbortSignal) => Promise<Blob>
  /** tests: how the page is parsed and written back (default DOMParser and the document's outerHTML) */
  parse?: (html: string) => Document
  serialize?: (doc: Document) => string
}

export interface FrameFiles {
  /** the page to show: the original text when nothing had to change */
  html: string
  /** different web images left out (for the notice) */
  external: number
  /** different team files that could not be put in (missing, not allowed, too large, not an image or clip, refused) */
  missing: number
}

/** The page with its team images and clips inlined (see the header). */
export async function resolveFrameFiles(html: string, o: FrameFilesOptions): Promise<FrameFiles> {
  const doc = (o.parse ?? ((s: string) => new DOMParser().parseFromString(s, 'text/html')))(html)
  const sites = sitesOf(doc)
  const external = new Set<string>()
  const missing = new Set<string>()
  const wanted = new Map<string, string | null>() // team path -> data URL (null: not available)
  const order: string[] = []
  const refs = new Map<string, Ref>()
  for (const s of sites) {
    for (const raw of refsOf(s)) {
      if (refs.has(raw)) continue
      const r = classifyRef(raw, o.folder)
      refs.set(raw, r)
      if (r.kind === 'external') external.add(raw.trim())
      else if (r.kind === 'blocked') missing.add(raw.trim())
      else if (r.kind === 'team' && !wanted.has(r.path)) {
        wanted.set(r.path, null)
        if (!mediaMime(r.path) || order.length >= FRAME_FILES_MAX) missing.add(r.path)
        else order.push(r.path)
      }
    }
  }
  if (!refs.size) return { html, external: 0, missing: 0 }
  const fetchFile = o.fetchFile ?? ((p: string, max: number, signal?: AbortSignal) => fetchFileBlob(p, max, signal, { embedIn: o.embedIn }))
  let total = 0
  let next = 0
  const worker = async () => {
    while (next < order.length) {
      const p = order[next++]!
      o.signal?.throwIfAborted()
      try {
        const blob = await fetchFile(p, FRAME_FILE_BYTES, o.signal)
        if (blob.size > FRAME_FILE_BYTES || total + blob.size > FRAME_FILES_BYTES) { missing.add(p); continue }
        total += blob.size
        wanted.set(p, await dataUrl(blob, mediaMime(p)!))
      } catch (e) {
        if (o.signal?.aborted) throw e
        missing.add(p)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, order.length) }, worker))
  o.signal?.throwIfAborted()
  const swap = (raw: string): string | null => {
    const r = refs.get(raw) ?? classifyRef(raw, o.folder)
    if (r.kind === 'keep') return null
    if (r.kind === 'team') return wanted.get(r.path) ?? PLACEHOLDER
    return PLACEHOLDER
  }
  let changed = false
  for (const s of sites) {
    const before = s.get()
    const after = rewrite(s, swap)
    if (after === before) continue
    s.set(after)
    changed = true
    // an <img> with only a srcset: also a src, which a static view keeps (cleanStatic drops srcset)
    if (s.kind === 'srcset' && s.el.localName.toLowerCase() === 'img' && !s.el.hasAttribute('src')) {
      const first = srcsetParts(after)[0]
      if (first) s.el.setAttribute('src', first.url)
    }
  }
  if (!changed) return { html, external: external.size, missing: missing.size }
  const doctype = /^\s*<!doctype/i.test(html) ? '<!doctype html>' : ''
  const out = (o.serialize ?? ((d: Document) => doctype + d.documentElement.outerHTML))(doc)
  return { html: out, external: external.size, missing: missing.size }
}

/** A short, stable key for a page (a frame per document: SandboxFrame), so a key is not the whole page text. */
export function pageKey(html: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return `${html.length.toString(36)}-${(h >>> 0).toString(36)}`
}
