// File links in an answer whose path the AI typed wrong (AI flow check 2026-11-17, FL-01 and FL-28). The instructions
// ask for links to team files as [name](/files/view?path=<team path, URL-encoded>) (prompt.ts SOURCE_LINK_RULE), and the
// model writes the percent-encoding of a Korean path byte by byte itself. It slips: "단가표" came out as "단기표"
// (%EA%B0%80 → %EA%B8%B0) and "2026-11-15-일요일-회의록.md" as "2026-11-15-일요일-을요일-회의록.md", while the label
// it wrote was right. The link then opened nothing. A link whose path is no file or folder the person may open is
// pointed at the one its label (or its own last part) names: in the folder the link names, else among this turn's own
// files; matched by NFC, so a name stored decomposed (a Mac upload) matches too. Anything else stays as written.
//
// The answer streams: push() gives back the text that is safe to show now and holds back a Markdown link that is not
// complete yet; flush() gives back the rest. A link is only ever re-pointed at a path the person may read.
import fs from 'node:fs'
import path from 'node:path'
import { FILE_VIEW_PATH } from '@mycel/shared/api'
import type { FileService } from '../files/service'
import type { Principal } from '../policy/access'
import { authorize } from '../policy/authorize'
import { badSegment, hiddenEntry } from '../policy/names'

/** The team path a link of `path` (as decoded) labelled `label` should open, or null to leave the link as it is. */
export type FileLinkResolve = (path: string, label: string) => string | null

// a Markdown link (not an image): [label](url "title"); the url may hold balanced parentheses ('Report (final).pptx')
const LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*(<?)((?:[^\s()<>]|\([^\s()<>]*\))+)(>?)(\s+"[^"\n]*")?\s*\)/g
// the start of a Markdown link that is not complete yet: '[label', '[label]', '[label](url'
const OPEN_LINK = /^\[[^\]\n]*(?:\](?:\((?:[^()\n]|\([^()\n]*\))*(?:\([^()\n]*)?)?)?$/
const HOLD_MAX = 2000
const ROUTES = [FILE_VIEW_PATH, '/api/files/download']

/** The `path` query value of a relative team-file link, decoded (null: not such a link). A slip in the encoding can make
 * bytes that are no UTF-8: then the value does not decode at all (''), and only the label is left to go by. */
export function linkPath(url: string): string | null {
  if (!url.startsWith('/') || url.startsWith('//')) return null
  const q = url.indexOf('?')
  const route = (q < 0 ? url : url.slice(0, q)).replace(/#.*$/, '')
  if (!ROUTES.includes(route) || q < 0) return null
  const part = url.slice(q + 1).replace(/#.*$/, '').split('&').find((p) => p.startsWith('path='))
  if (part === undefined) return null
  try { return decodeURIComponent(part.slice(5).replace(/\+/g, ' ')) } catch { return '' }
}

/** `url` with its `path` value set to `rel` (encoded); the rest of the link (&sheet=, &page=, a #) as it was. */
export function withLinkPath(url: string, rel: string): string {
  const q = url.indexOf('?')
  const hash = url.indexOf('#', q)
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash)
  const parts = query.split('&').map((p) => p.startsWith('path=') ? `path=${encodeURIComponent(rel)}` : p)
  return `${url.slice(0, q)}?${parts.join('&')}${hash < 0 ? '' : url.slice(hash)}`
}

/** Complete text: each team-file link `resolve` re-points gets the right path; everything else stays. */
export function repairFileLinks(text: string, resolve: FileLinkResolve): string {
  if (!text.includes('](')) return text
  return text.replace(LINK_RE, (all, img: string, label: string, lt: string, url: string, gt: string, title: string | undefined) => {
    if (img) return all
    const p = linkPath(url)
    if (p === null) return all
    let fixed: string | null = null
    try { fixed = resolve(p, label) } catch { fixed = null }
    if (!fixed || fixed === p) return all
    return `[${label}](${lt}${withLinkPath(url, fixed)}${gt}${title ?? ''})`
  })
}

/** The streaming side: holds a link that is not complete yet, repairs complete ones. */
export class FileLinkRepair {
  private pending = ''
  constructor(private readonly resolve: FileLinkResolve) {}
  get held(): string { return this.pending }
  clear() { this.pending = '' }

  push(piece: string): string {
    this.pending += piece
    let cut = this.pending.length
    const b = this.pending.lastIndexOf('[')
    if (b >= 0 && this.pending.length - b <= HOLD_MAX && OPEN_LINK.test(this.pending.slice(b))) cut = b
    const out = this.pending.slice(0, cut)
    this.pending = this.pending.slice(cut)
    return repairFileLinks(out, this.resolve)
  }

  flush(): string {
    const out = this.pending
    this.pending = ''
    return repairFileLinks(out, this.resolve)
  }
}

const nfc = (s: string) => s.normalize('NFC')
/** a link label as a file name: without code marks or surrounding space */
const labelName = (label: string) => nfc(label.replace(/`/g, '').trim())

/**
 * The resolver for one person: a link whose path they may open stays; else the entry of the link's folder whose name
 * is the label (or the link's own last part, NFC), else the one file of `known` (this turn's own files) of that name.
 * Only a path the person may read.
 */
export function fileLinkResolver(files: FileService, user: () => Principal, known: () => readonly string[] = () => []): FileLinkResolve {
  const readable = (rel: string): boolean => {
    if (!rel) return false
    try { authorize(files.fx, files.rules(), user(), rel, 'read'); return true } catch { return false }
  }
  return (raw, label) => {
    const p = raw.replace(/^\/+|\/+$/g, '')
    if (p && !p.includes('\uFFFD') && readable(p)) return null
    const names = [...new Set([labelName(label), nfc(p.slice(p.lastIndexOf('/') + 1))])].filter((n) => n && !n.includes('\uFFFD') && !n.includes('/'))
    if (!names.length) return null
    // the folder the link names (its folder part is usually right): an entry of that name
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (dir && !dir.includes('\uFFFD')) {
      const segs = dir.split('/')
      let ents: string[] = []
      try { ents = fs.readdirSync(path.join(files.fx.root, ...segs)) } catch { ents = [] }
      for (const n of names) {
        const hit = ents.find((e) => nfc(e) === n && !hiddenEntry(e, segs.length) && !badSegment(e))
        if (hit && readable(`${dir}/${hit}`)) return `${dir}/${hit}`
      }
    }
    // this turn's own files of that name: only one, never a guess between two
    for (const n of names) {
      const hits = [...new Set(known().filter((k) => nfc(k.slice(k.lastIndexOf('/') + 1)) === n))]
      if (hits.length === 1 && readable(hits[0]!)) return hits[0]!
    }
    return null
  }
}
