// Text fixes before an answer's Markdown is rendered (no DOM, no network; test/unit/markdown.test.ts).
// Ported from Saram web/src/lib/markdown.ts.
import remend from 'remend'
import { FILE_VIEW_PATH, locFromQuery, type SourceLoc } from '@mycel/shared/api'

// $…$ is math when (as in pandoc) the opening $ is followed and the closing $ preceded by a non-space, and the closing
// $ is not followed by a digit: "$1$", "$x^2$" are math; "$5 coupon and $10 off" is not.
/** Escape the dollars of prices ("$5"), spreadsheet refs ("$A$1") and env vars ("$PATH") outside math. */
function guardLine(line: string) {
  return line
    .split(/(\$\$[\s\S]*?\$\$|\$(?=\S)(?:[^$\n\\]|\\.)*?\S\$(?!\d)|\$[^\s$]\$(?!\d))/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/(?<!\\)\$([A-Z]{1,3})\$(\d+)/g, '\\$$$1\\$$$2')
            .replace(/(?<![\\$\w])\$(?=\d)/g, '\\$')
            .replace(/(?<![\\$\w])\$([A-Z_][A-Z0-9_]{1,})\b/g, '\\$$$1'),
    )
    .join('')
}

// Engines (Codex especially) write LaTeX delimiters \( … \) and \[ … \]; remark-math only knows $…$ and $$…$$, and
// Markdown reads "\[" as a plain "[", so the formula showed as "[ A = P(1+r)^n ]". \( … \) is always math (Markdown
// has no reason to escape a parenthesis); \[ … \] only when the inside looks like math, so an escaped "\[note\]" stays.
const MATHY = /[\\^_=+*/<>]|\d/
function latexDelimiters(part: string) {
  return part
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, body: string) => (MATHY.test(body) ? `\n$$\n${body.trim()}\n$$\n` : m))
    .replace(/\\\(([^\n]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`)
}

/**
 * Single-dollar math on, without eating prices; code spans and fences are left alone. While streaming, close what is
 * still open (bold, a code fence, a link…) so the half-written answer doesn't flash raw markdown.
 */
export function prepareMarkdown(text: string, streaming?: boolean) {
  const guarded = text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : latexDelimiters(part).split('\n').map(guardLine).join('\n')))
    .join('')
  return streaming ? remend(guarded, { linkMode: 'text-only' }) : guarded
}

export type LinkKind =
  | { kind: 'team-file'; path: string; at?: SourceLoc }
  | { kind: 'external'; href: string }
  | { kind: 'app'; href: string }
  | { kind: 'blocked' }

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/** A team-folder path that names a file (has an extension), not a folder: share_file / make_file links to files. */
export const looksLikeFile = (p: string) => /\.[A-Za-z0-9]{1,10}$/.test(p.slice(p.lastIndexOf('/') + 1))

/** Where /files/view?path=… (the share link of C's share_file / make_file tools) goes inside the app; `q`: the rest of
 * the link, whose page / sheet / slide (locQuery) opens a file at that place. */
export function fileViewTarget(p: string, q?: URLSearchParams): { kind: 'file'; path: string; folder: string; at?: SourceLoc } | { kind: 'folder'; path: string } {
  const clean = p.replace(/^\/+|\/+$/g, '')
  const at = q ? locFromQuery(q) : null
  return looksLikeFile(clean) ? { kind: 'file', path: clean, folder: clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '', ...(at ? { at } : {}) } : { kind: 'folder', path: clean }
}

/**
 * What a link in an answer points to. Team files (/api/files/download?path=…, /files/view?path=<file>) open in the
 * preview panel; a shared folder (/files/view?path=<folder>) opens the files screen there; other
 * same-origin paths stay in the app; http(s)/mailto/tel open in a new tab; anything else (javascript:, data:, file:)
 * is not a link.
 */
export function classifyLink(href: string | undefined, origin: string): LinkKind {
  if (!href) return { kind: 'blocked' }
  let u: URL
  try { u = new URL(href, origin) } catch { return { kind: 'blocked' } }
  if (u.origin === origin) {
    if (u.pathname === '/api/files/download') {
      const path = u.searchParams.get('path')
      return path ? { kind: 'team-file', path } : { kind: 'blocked' }
    }
    if (u.pathname.startsWith('/api/')) return { kind: 'blocked' }
    if (u.pathname === FILE_VIEW_PATH) {
      const path = u.searchParams.get('path')
      if (path === null) return { kind: 'app', href: '/files' }
      const target = fileViewTarget(path, u.searchParams)
      return target.kind === 'file' ? { kind: 'team-file', path: target.path, ...(target.at ? { at: target.at } : {}) } : { kind: 'app', href: `/files?path=${encodeURIComponent(target.path)}` }
    }
    return { kind: 'app', href: u.pathname + u.search + u.hash }
  }
  return SAFE_SCHEMES.has(u.protocol) ? { kind: 'external', href: u.href } : { kind: 'blocked' }
}

export type ImageKind = { kind: 'team-file'; path: string } | { kind: 'attachment-thumb'; url: string } | { kind: 'inline-data'; src: string } | { kind: 'external'; href: string; host: string } | { kind: 'blocked' }

const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/

/**
 * Images in answers (tab 5 "답변 표시 보안"): team-server images load; external images never load by themselves (a
 * URL can carry data out), the person opens them in a new tab. Inline data: images only as png/jpeg/gif/webp.
 */
export function classifyImage(src: string | undefined, origin: string): ImageKind {
  if (!src) return { kind: 'blocked' }
  if (src.startsWith('data:')) return IMAGE_DATA.test(src) ? { kind: 'inline-data', src } : { kind: 'blocked' }
  let u: URL
  try { u = new URL(src, origin) } catch { return { kind: 'blocked' } }
  if (u.origin === origin) {
    if (u.pathname === '/api/files/download' && u.searchParams.get('path')) return { kind: 'team-file', path: u.searchParams.get('path')! }
    if (/^\/api\/uploads\/[0-9a-f-]+\/thumbnail$/.test(u.pathname)) return { kind: 'attachment-thumb', url: u.pathname }
    return { kind: 'blocked' }
  }
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'external', href: u.href, host: u.host }
  return { kind: 'blocked' }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i
/** Team-server images shown directly: png/jpeg/gif/webp; SVG only through <img> (scripts never run there). */
export const isDisplayableImagePath = (path: string) => IMAGE_EXT.test(path) || /\.svg$/i.test(path)

/** Markdown as one line of plain text, for a short summary (a project's instructions under its name): no code blocks,
 * images, heading / list / quote marks or emphasis; a link keeps its words. Underscores stay (snake_case names). */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ' ')
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/\*+|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The first paragraph of markdown as plain text, for a summary (a project's instructions under its name): headings,
 * lists, tables, images and code are passed over; with no paragraph at all, all of it. */
export function firstParagraph(md: string): string {
  const blocks = md.replace(/```[\s\S]*?(?:```|$)/g, '\n\n').split(/\n[ \t]*\n/)
  for (const block of blocks) {
    const body = block.split('\n').filter((l) => !/^[ \t]{0,3}#{1,6}[ \t]/.test(l)).join('\n').trim()
    if (!body || /^(?:[-*+][ \t]|\d+[.)][ \t]|\||!\[|(?:[-*_][ \t]*){3,}$)/.test(body)) continue
    const text = plainText(body)
    if (text) return text
  }
  return plainText(md)
}

/** A Markdown file's leading YAML front matter (`---` … `---`, as a SKILL.md starts): its `name` and `description` and
 * the text after it. The file preview shows the two as a quiet block instead of the raw lines (which Markdown drew as
 * one bold heading). Only a block whose lines read as YAML counts: a page that opens with a rule and a paragraph comes
 * back whole. */
export function splitFrontMatter(text: string): { name?: string; description?: string; body: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return { body: text }
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(l))
  if (end < 0) return { body: text }
  const yaml = lines.slice(1, end)
  const KEY = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*))?$/
  // top-level "key: value", indented or list continuation lines, comments and blank lines; anything else is not YAML
  if (!yaml.every((l) => !l.trim() || /^[ \t]/.test(l) || l.startsWith('#') || /^-(?:[ \t]|$)/.test(l) || KEY.test(l))) return { body: text }
  const fields = new Map<string, string[]>()
  let key: string | null = null
  for (const l of yaml) {
    const top = KEY.exec(l)
    if (top) fields.set((key = top[1]!), [top[2]?.trim() ?? ''])
    else if (key && l.trim() && !l.startsWith('#')) fields.get(key)!.push(l.trim())
  }
  const value = (k: string) => {
    const [first = '', ...rest] = fields.get(k) ?? []
    // a block scalar (">", "|", ">-") starts its text on the next lines
    const v = [/^[>|][+-]?\d*$/.test(first) ? '' : first, ...rest].filter(Boolean).join(' ').trim()
    const quoted = /^"(.*)"$/s.exec(v)?.[1]?.replace(/\\"/g, '"') ?? /^'(.*)'$/s.exec(v)?.[1]?.replace(/''/g, "'")
    return (quoted ?? v) || undefined
  }
  return { name: value('name'), description: value('description'), body: lines.slice(end + 1).join('\n') }
}
