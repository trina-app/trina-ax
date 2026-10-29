// Link guard for the "api" engine (engine/api-agent.ts). Models behind an OpenAI-compatible API made up preview links
// to team files (QA B-API-2, 2026-10-29: the tools gave the correct local link, the answer showed another one). The
// guard lets a link to this team server's file routes (/files/view, /api/files/…) through only when a tool result, the
// system prompt or the user message of this turn holds the same link (same route and same `path`); any other such link
// becomes plain text. Links to other hosts (web pages, Drive) are not changed.
//
// The answer streams: push() gives back the text that is safe to show now and holds back a possible link that is not
// complete yet (an open `[...](...` or the last word); flush() gives back the rest at the end of each completion.
import { FILE_VIEW_PATH } from '@mycel/shared/api'

const ROUTE = new RegExp(`^(?:${FILE_VIEW_PATH.replace(/\//g, '\\/')}(?:$|[?#])|\\/api\\/files\\/)`)
// URL characters with balanced parentheses (CommonMark): file names such as 'Report (final).pptx' or a conflict copy
// 'name (conflict copy - person date).ext' keep their '(' and ')' when a model decodes or retypes the link. An
// unbalanced ')' ends the URL, so '(see /files/view?path=a)' does not take the closing parenthesis.
const urlChars = (c: string) => `(?:${c}|\\(${c}*\\))`
const FREE = `[^\\s<>()\\[\\]"'\`]`
// a URL in free text: absolute http(s), or a relative team-route path (not part of a longer path or word)
const URL_SRC = `(?:https?:\\/\\/${urlChars(FREE)}+|(?<![\\w.\\/])\\/(?:files\\/view|api\\/files\\/)${urlChars(FREE)}*)`
const URL_RE = new RegExp(URL_SRC, 'g')
// a Markdown link or image: [label](url "title"), or a bare URL (also <url>)
const LINK_RE = new RegExp(`(!?)\\[([^\\]\\n]*)\\]\\(\\s*<?(${urlChars('[^\\s()<>]')}+)>?(?:\\s+"[^"\\n]*")?\\s*\\)|<?(${URL_SRC})>?`, 'g')
// the start of a Markdown link that is not complete yet: '[label', '[label]', '[label](url' (the url may hold
// balanced parentheses and one '(' that is not closed yet)
const OPEN_LINK = /^\[[^\]\n]*(?:\](?:\((?:[^()\n]|\([^()\n]*\))*(?:\([^()\n]*)?)?)?$/
const HOLD_MAX = 2000

export class LinkGuard {
  private held = ''
  private readonly allowed = new Set<string>()
  private readonly origins: Set<string>

  constructor(origins: readonly string[] = []) {
    this.origins = new Set(origins.map((o) => { try { return new URL(o).origin } catch { return '' } }).filter(Boolean))
  }

  /** The key of a link to a team file route, or null when the link goes elsewhere. */
  key(url: string): string | null {
    const relative = url.startsWith('/') && !url.startsWith('//')
    if (!relative && !/^https?:\/\//i.test(url)) return null
    let u: URL
    try { u = new URL(url, 'http://team.invalid') } catch { return null }
    if (!relative && !this.origins.has(u.origin)) return null
    if (!ROUTE.test(u.pathname)) return null
    return `${u.pathname}|${u.searchParams.get('path') ?? ''}`
  }

  /** Team links in this text (a tool result, the instructions, the user message) become allowed in the answer. */
  allow(text: string): string[] {
    const found: string[] = []
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?]+$/, '')
      const k = this.key(url)
      if (k) { this.allowed.add(k); found.push(url) }
    }
    return [...new Set(found)]
  }

  private ok(url: string): boolean {
    const k = this.key(url)
    return k === null || this.allowed.has(k)
  }

  /** Complete text: team links that no tool gave become plain text (a Markdown link keeps its label). */
  clean(text: string): string {
    return text.replace(LINK_RE, (all, _img: string, label: string | undefined, mdUrl: string | undefined, bare: string | undefined) => {
      if (mdUrl !== undefined) return this.ok(mdUrl) ? all : (label ?? '')
      const url = (bare ?? '').replace(/[.,;:!?]+$/, '')
      const tail = (bare ?? '').slice(url.length)
      return this.ok(url) ? all : tail
    })
  }

  /** A streamed piece of the answer in; the part that can be shown now out. */
  push(delta: string): string {
    this.held += delta
    let cut = this.held.length
    const b = this.held.lastIndexOf('[')
    if (b >= 0 && OPEN_LINK.test(this.held.slice(b))) cut = b
    const ws = Math.max(this.held.lastIndexOf(' ', cut - 1), this.held.lastIndexOf('\n', cut - 1), this.held.lastIndexOf('\t', cut - 1))
    cut = ws + 1 < cut ? ws + 1 : cut
    if (this.held.length - cut > HOLD_MAX) cut = this.held.length
    const out = this.clean(this.held.slice(0, cut))
    this.held = this.held.slice(cut)
    return out
  }

  flush(): string {
    const out = this.clean(this.held)
    this.held = ''
    return out
  }
}
