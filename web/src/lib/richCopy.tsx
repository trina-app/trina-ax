// "Copy" under an answer, like Claude's: the answer goes on the clipboard twice, as formatted text (text/html, so a
// paste into Gmail, Outlook, Word or Google Docs keeps headings, bold, lists, links, code blocks and real tables) and
// as its Markdown (text/plain, as before, for editors, chat boxes and anything that takes plain text).
// The HTML is made from the answer's Markdown with the same parser as the screen (Markdown.tsx: GFM, Korean-friendly
// emphasis, math), but with plain elements and inline styles that mail and word processors keep (they drop classes and
// style sheets): bordered tables, grey code blocks, a quoted bar. Nothing in it loads by itself where it is pasted:
// external images become links (a pasted <img> would be fetched by the reader's mail program, and its address can carry
// data out, the reason the screen never loads them either), team-file images and links become links to the file on
// the team server at the same place (a page, sheet or slide; whoever opens them signs in and is checked), math and Mermaid diagrams stay as their source, and
// raw HTML in the answer stays text (as on the screen). Hidden HTML comments stay hidden.
import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import ReactMarkdown, { type Components } from 'react-markdown'
import { fileShareUrl } from '@mycel/shared/api'
import { REMARK, codeOf, hideHtmlComments, urlTransform } from '../components/Markdown'
import { classifyImage, classifyLink, prepareMarkdown } from './markdown'
import { baseName } from './paths'

const MONO = 'Menlo, Consolas, "Courier New", monospace'
const BORDER = '1px solid #d0d7de'
const S = {
  table: { borderCollapse: 'collapse', margin: '8px 0' },
  cell: { border: BORDER, padding: '4px 8px', verticalAlign: 'top', textAlign: 'left' },
  head: { background: '#f6f8fa', fontWeight: 600 },
  pre: { margin: '8px 0', padding: '8px 12px', background: '#f6f8fa', border: BORDER, borderRadius: '6px', fontFamily: MONO, fontSize: '13px', lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  code: { fontFamily: MONO, fontSize: '0.9em', background: '#f6f8fa', padding: '1px 4px', borderRadius: '4px' },
  quote: { margin: '8px 0', padding: '0 0 0 12px', borderLeft: '3px solid #d0d7de', color: '#57606a' },
  img: { maxWidth: '100%' },
} satisfies Record<string, CSSProperties>

/** The cell's own alignment (a GFM column: react-markdown turns `align` into style.textAlign) over the default left. */
const cellStyle = (style: CSSProperties | undefined, head: boolean): CSSProperties => ({ ...S.cell, ...(head ? S.head : {}), ...(style?.textAlign ? { textAlign: style.textAlign } : {}) })

const keyOf = (part: string) => {
  try { return decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')) } catch { return part.split('=')[0] }
}

/**
 * The copy's address of a team file the answer links to: its preview page with every other query parameter the link
 * had, in its order and spelling (&page=12, &sheet=…&range=…, &slide=3, and any other), so the pasted link opens the
 * same place as a click on the screen. Only `path` is written again (fileShareUrl), and a download link's own
 * `disposition` is left out: the copy links to the preview, as the screen opens it.
 */
export function teamFileCopyHref(href: string, path: string, origin: string): string {
  let u: URL
  try { u = new URL(href, origin) } catch { return fileShareUrl(path, 'preview') }
  const download = u.pathname === '/api/files/download'
  const rest = u.search
    .slice(1)
    .split('&')
    .filter((part) => part && keyOf(part) !== 'path' && !(download && keyOf(part) === 'disposition'))
    .map((part) => part.replace(/\(/g, '%28').replace(/\)/g, '%29'))
  return fileShareUrl(path, 'preview') + rest.map((part) => '&' + part).join('')
}

function copyComponents(origin: string): Components {
  const abs = (href: string) => origin.replace(/\/+$/, '') + href
  const fileLink = (href: string, path: string, children: ReactNode) => <a href={abs(teamFileCopyHref(href, path, origin))}>{children}</a>
  return {
    // border and cellpadding too: Outlook's Word engine and older pastes read the attributes, the rest the styles
    table: ({ children }) => <table border={1} cellPadding={6} cellSpacing={0} style={S.table}>{children}</table>,
    th: ({ children, style }) => <th style={cellStyle(style, true)}>{children}</th>,
    td: ({ children, style }) => <td style={cellStyle(style, false)}>{children}</td>,
    // code blocks (and Mermaid, and display math) as their source in a grey block; the language is not a header here
    pre: ({ node, children }) => {
      const c = codeOf(node)
      return <pre style={S.pre}>{c ? <code>{c.code}</code> : children}</pre>
    },
    code: ({ children }) => <code style={S.code}>{children}</code>,
    blockquote: ({ children }) => <blockquote style={S.quote}>{children}</blockquote>,
    // a task list's checkbox: a character a paste keeps (mail programs drop form fields)
    input: ({ checked, type }) => (type === 'checkbox' ? <>{checked ? '☑' : '☐'}</> : null),
    a: ({ href, children }) => {
      // footnote and heading anchors point into this page only
      if (!href || href.startsWith('#')) return <>{children}</>
      const l = classifyLink(href, origin)
      if (l.kind === 'team-file') return fileLink(href, l.path, children)
      if (l.kind === 'app') return <a href={abs(l.href)}>{children}</a>
      if (l.kind === 'external') return <a href={l.href}>{children}</a>
      return <>{children}</>
    },
    img: ({ src, alt }) => {
      const k = classifyImage(typeof src === 'string' ? src : undefined, origin)
      if (k.kind === 'inline-data') return <img src={k.src} alt={alt ?? ''} style={S.img} />
      if (k.kind === 'team-file') return fileLink(src as string, k.path, alt || baseName(k.path))
      if (k.kind === 'external') return <a href={k.href}>{alt || k.host}</a>
      return <>{alt ? `[${alt}]` : ''}</>
    },
  }
}

/** The React tree of an answer's copy (for the clipboard, or renderToStaticMarkup in tests). */
export function copyElement(markdown: string, origin: string): ReactElement {
  return createElement(ReactMarkdown, { remarkPlugins: REMARK, rehypePlugins: [hideHtmlComments], components: copyComponents(origin), urlTransform }, prepareMarkdown(markdown))
}

/** Render it to an HTML string in the page (react-dom/server is not in the app's bundle). */
function renderInPage(el: ReactElement): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    flushSync(() => root.render(el))
    return host.innerHTML
  } finally {
    root.unmount()
  }
}

/** The answer as HTML for the clipboard. */
export function answerHtml(markdown: string, origin = location.origin, render: (el: ReactElement) => string = renderInPage): string {
  return render(copyElement(markdown, origin))
}
