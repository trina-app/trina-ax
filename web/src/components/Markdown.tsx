// Answer Markdown (GFM + math + Mermaid + highlighted code), ported from Saram's ui.tsx / markdownExtras.tsx and
// extended from chat-proto: code blocks with language colours, copy and download; tables that copy into
// Sheets/Excel; links to team files open the preview panel, their pictures the image viewer; external images never load
// by themselves.
import 'katex/dist/katex.min.css'
import clsx from 'clsx'
import type { Element, ElementContent, Root, RootContent } from 'hast'
import { fromHtml } from 'hast-util-from-html'
import { Check, ChevronRight, Copy, Download, FileText, ImageOff, ExternalLink, Lock } from 'lucide-react'
import { createContext, memo, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from 'react-router-dom'
import rehypeKatex from 'rehype-katex'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { fileUrl, saveBlob } from '../lib/api'
import { classifyImage, classifyLink, isDisplayableImagePath, prepareMarkdown, teamLinkTarget } from '../lib/markdown'
import { previewKind } from '../lib/preview'
import type { SourceLoc } from '@mycel/shared/api'
import { openFilePreview, openTeamFile, type PreviewFile } from '../lib/sidePanel'
import { baseName } from '../lib/paths'
import { useT } from '../i18n'
import { mobileApp } from '../lib/mobile'
import { externalImageHintKey } from '../lib/appWording'
import { toast } from '../store/ui'
import { useCopy, useEdgeFade } from './ui'
import { Tooltip } from './Tooltip'
import { useViewerItem } from './ImageViewer'
import { teamImageItem } from '../lib/imageViewer'
import { useDarkTheme } from '../lib/theme'

const mathRemark = [remarkMath, { singleDollarTextMath: true }] as const
const mathRehype = [rehypeKatex, { throwOnError: false, strict: false, trust: false, maxExpand: 500 }] as const

const textOf = (n: ElementContent): string => (n.type === 'text' ? n.value : n.type === 'element' ? n.children.map(textOf).join('') : '')

/** The language and source of a fenced code block, or null for any other <pre>. */
export function codeOf(pre: Element | undefined): { lang: string | null; code: string } | null {
  const code = pre?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return null
  const cls = code.properties?.className
  const lang = Array.isArray(cls) ? (cls.map(String).find((c) => c.startsWith('language-'))?.slice(9) ?? null) : null
  return { lang, code: code.children.map(textOf).join('').replace(/\n$/, '') }
}

// ---------------- Mermaid ----------------
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
const loadMermaid = () =>
  (mermaidReady ??= import('mermaid').then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
    return m
  }))
/** Mermaid's theme for the app's look: a dark diagram on a dark card in the dark theme (a white box there glared), the
 * light one otherwise. A copy keeps the diagram's source (lib/richCopy.tsx), so the look never travels with it. */
export const mermaidTheme = (dark: boolean) => (dark ? 'dark' : 'neutral')
/** drawn diagrams, by theme and source */
const drawn = new Map<string, string>()
/** One drawing at a time, each with its own theme: Mermaid's settings are global and its render reads them when it
 * runs, so a theme set for one drawing must not reach another still waiting. */
let drawing: Promise<unknown> = Promise.resolve()
const drawMermaid = (theme: ReturnType<typeof mermaidTheme>, code: string): Promise<string> => {
  const next = drawing.then(async () => {
    const m = await loadMermaid()
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
    return (await m.render(`mmd-${Math.random().toString(36).slice(2)}`, code)).svg
  })
  drawing = next.catch(() => {})
  return next
}

/** A Mermaid diagram in an answer. Shows the source while it is still being written or doesn't parse. */
export function MermaidBlock({ code }: { code: string }) {
  const t = useT()
  const theme = mermaidTheme(useDarkTheme())
  const key = `${theme}\n${code}`
  // the picture shown and the theme it was drawn with (the last one stays while the other look's is drawn)
  const [shown, setShown] = useState<{ svg: string; theme: string } | null>(() => (drawn.has(key) ? { svg: drawn.get(key)!, theme } : null))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (drawn.has(key)) {
      setShown({ svg: drawn.get(key)!, theme })
      setFailed(false)
      return
    }
    let live = true
    void loadMermaid().catch(() => {})
    // wait for the fence to stop changing (streaming) before drawing
    const timer = setTimeout(async () => {
      const draw = async () => {
        if (document.visibilityState !== 'visible') await new Promise((r) => document.addEventListener('visibilitychange', r, { once: true }))
        await document.fonts.ready
        return drawMermaid(theme, code)
      }
      try {
        const out = await draw().catch(async () => {
          await new Promise((r) => setTimeout(r, 700))
          return draw()
        })
        drawn.set(key, out)
        if (live) {
          setShown({ svg: out, theme })
          setFailed(false)
        }
      } catch {
        if (live) setFailed(true)
      }
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key, code, theme])
  if (shown && !failed)
    return (
      // securityLevel strict: mermaid sanitizes labels (DOMPurify) and turns off click handlers. The card is the colour
      // of the theme the picture was drawn with
      <div role="img" aria-label={t('md.diagram')} className={clsx('not-prose my-3 flex justify-center overflow-x-auto rounded-lg border border-line p-4 [&_svg]:h-auto [&_svg]:max-w-full', shown.theme === 'dark' ? 'bg-surface' : 'bg-white')} data-theme={shown.theme} data-testid="md-mermaid" dangerouslySetInnerHTML={{ __html: shown.svg }} />
    )
  return <CodeBlock lang="mermaid" code={code} />
}

// ---------------- code ----------------
let hljsReady: Promise<typeof import('highlight.js').default> | null = null
const loadHljs = () => (hljsReady ??= import('highlight.js/lib/common').then((m) => m.default))
const LANG_EXT: Record<string, string> = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', json: 'json', yaml: 'yml', yml: 'yml', html: 'html', css: 'css', sql: 'sql', go: 'go', rust: 'rs', java: 'java', tsx: 'tsx', jsx: 'jsx', markdown: 'md', md: 'md', xml: 'xml', csv: 'csv', mermaid: 'mmd' }

export function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const t = useT()
  const [html, setHtml] = useState<string | null>(null)
  const { copied, copy } = useCopy()
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void loadHljs().then((h) => {
        if (!live) return
        try {
          // highlight.js escapes the source; its output only contains <span class="hljs-…">
          const out = lang && h.getLanguage(lang) ? h.highlight(code, { language: lang, ignoreIllegals: true }) : code.length < 20_000 ? h.highlightAuto(code) : null
          setHtml(out?.value ?? null)
        } catch {
          setHtml(null)
        }
      })
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [lang, code])
  return (
    <div className="not-prose group my-3 overflow-hidden rounded-lg bg-code-bg text-code-ink dark:ring-1 dark:ring-line">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1 text-xs text-[#b9b3a8] select-none">
        <span>{lang ?? t('md.code')}</span>
        <span className="flex items-center gap-1 max-md:gap-3">
          <button type="button" className="touch-hit flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white" onClick={() => void copy(code)} aria-label={copied ? t('common.copied') : t('md.copyCode')}>
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            <span>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
          <Tooltip label={t('md.downloadCode')}>
            <button type="button" className="touch-hit rounded p-1 hover:bg-white/10 hover:text-white" aria-label={t('md.downloadCode')} onClick={() => saveBlob(new Blob([code], { type: 'text/plain;charset=utf-8' }), `code.${LANG_EXT[lang ?? ''] ?? 'txt'}`)}>
              <Download size={13} aria-hidden />
            </button>
          </Tooltip>
        </span>
      </div>
      <pre className="m-0 overflow-x-auto p-3 text-code leading-5">
        {html !== null ? <code className="hljs font-mono" dangerouslySetInnerHTML={{ __html: html }} /> : <code className="font-mono">{code}</code>}
      </pre>
    </div>
  )
}

// ---------------- tables ----------------
/** A table with a copy button: tab-separated text (cells land in their own Sheets/Excel cells) + a plain HTML table. */
function CopyableTable({ children }: { children: ReactNode }) {
  const t = useT()
  const ref = useRef<HTMLTableElement>(null)
  // a table wider than the answer scrolls sideways: the edge with more columns behind it fades, so the cut reads as "scroll"
  const scroller = useRef<HTMLDivElement>(null)
  useEdgeFade(scroller)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    const rows = [...ref.current!.rows].map((r) => [...r.cells].map((c) => ({ head: c.tagName === 'TH', text: c.innerText.replace(/\s*\n\s*/g, ' ').trim() })))
    const tsv = rows.map((r) => r.map((c) => c.text.replace(/\t/g, ' ')).join('\t')).join('\n')
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<table>${rows.map((r) => `<tr>${r.map((c) => (c.head ? `<th>${esc(c.text)}</th>` : `<td>${esc(c.text)}</td>`)).join('')}</tr>`).join('')}</table>`
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([tsv], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })])
    } catch {
      await navigator.clipboard.writeText(tsv).catch(() => {})
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    // the button sits under the table on the right, over nothing (on its top border it covered the last header cell);
    // phones: always shown, screens with a pointer: on hover or focus, like a quote's copy button
    <div className="group relative my-3 flex flex-col">
      <div className="relative">
        {/* a wider fade than the tab rows, and a round arrow at the cut edge: the mask alone is faint on the dark page */}
        <div ref={scroller} className="edge-fade peer overflow-x-auto rounded-lg border border-line [--fade:3rem]!" data-testid="md-table-scroll">
          <table ref={ref} className="m-0 min-w-full text-sm">
            {children}
          </table>
        </div>
        <span className="pointer-events-none absolute top-1/2 right-1.5 hidden size-6 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-surface text-muted shadow-sm peer-data-[fade-end]:flex" aria-hidden data-testid="md-table-more">
          <ChevronRight size={14} />
        </span>
      </div>
      <button
        type="button"
        onClick={copy}
        title={t('md.copyTableHint')}
        className="mt-1 flex items-center gap-1 self-end rounded-md px-1.5 py-0.5 text-xs font-medium text-muted transition select-none hover:bg-hover hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      >
        {copied ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? t('common.copied') : t('md.copyTable')}
      </button>
    </div>
  )
}

// ---------------- quotes ----------------
/** A quote with its own quiet copy button (an ad option, a message draft: each block copies on its own). Phones: the
 * button is always there, under the quote on the right; screens with a pointer: on hover or focus. No frame added.
 * Only top-level quotes of an assistant answer (labelQuotes, `copyQuotes`); `label` names what it copies. */
function CopyableQuote({ label, children }: { label: string; children: ReactNode }) {
  const t = useT()
  const ref = useRef<HTMLQuoteElement>(null)
  const { copied, copy } = useCopy()
  return (
    <div className="group/quote relative my-3 flex flex-col [&>blockquote]:my-0!" data-testid="copyable-quote">
      {/* upright and without the typography's added quote marks: an option to copy, not a citation (Korean has no italics) */}
      <blockquote ref={ref} className="not-italic [&>p:first-of-type]:before:content-none [&>p:last-of-type]:after:content-none">
        {children}
      </blockquote>
      <button
        type="button"
        onClick={() => void copy((ref.current?.innerText ?? ref.current?.textContent ?? '').trim())}
        aria-label={copied ? t('common.copied') : t('md.copyQuote', { what: label })}
        className="not-prose mt-1 flex items-center gap-1 self-end rounded-md px-1.5 py-0.5 text-xs font-medium text-muted transition select-none hover:bg-hover hover:text-ink [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/quote:opacity-100 [@media(hover:hover)]:group-hover/quote:opacity-100"
        data-testid="copy-quote"
      >
        {copied ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? t('common.copied') : t('common.copy')}
      </button>
    </div>
  )
}

/** The plain text of a table cell (its Markdown node). */
const cellText = (n: Element | ElementContent | undefined): string =>
  !n ? '' : n.type === 'text' ? n.value : 'children' in n ? n.children.map((c) => cellText(c as ElementContent)).join('') : ''
/** A number, amount, percent or date ("1,234.5", "-12%", "$3.2M", "2026-11-04"): it must not break over two lines. */
/** A cell that is one number, amount or count ("1,234,567", "₩987,654", "12,345건", "3.5만 원", "42%"): kept on one line,
 * its digits the same width. A unit after it may be up to 3 Latin letters, or one or two short words (1–2 letters each)
 * of Korean, Japanese or Chinese ("원", "만 원", "件"), so a Korean amount no longer wraps on a phone. */
export const isNumberCell = (text: string) => /^[-+−(]?[$€£¥₩]?\s?\d[\d.,:/\s-]*(%|[A-Za-z]{1,3}|[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,2}(\s?[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{1,2})?)?\)?$/u.test(text.trim())

// ---------------- links and images ----------------
/** Team files this viewer may open, where the text is shown to people with different access (an AI answer in a team
 * chat room: RoomMessage.openable). Inside it, a link or picture of any other team file is its name with a lock
 * (LockedFile): no chip to open, no picture loaded. Absent (null), as in the person's own chats, every team link is a
 * chip. */
const OpenableFiles = createContext<ReadonlySet<string> | null>(null)
/** The copies that went with the text (an answer shared with its files attached: RoomMessage.attachedLinks), by the link
 * as the text writes it: a link the viewer may not open as a team file opens its copy instead of showing a lock. */
const AttachedCopies = createContext<ReadonlyMap<string, PreviewFile> | null>(null)
/** Text from outside the team folder (a room file, a file picked on this computer): a team picture it names is a link to
 * open, never loaded by itself, so another person's file cannot put the viewer's own pictures into its page. */
const TeamImagesAsLinks = createContext(false)
const useLinkTarget = (path: string) => teamLinkTarget(path, useContext(OpenableFiles), useContext(AttachedCopies))

/** A file the AI made or mentioned: a link in the sentence, with a small file icon at the text's height, that opens the
 *  preview panel (which has the download; a file without a viewer shows the "can't be previewed" notice and a
 *  download button there). No frame, divider or button of its own: it reads like a word and wraps like one. In a room,
 *  one the viewer may not open but whose copy went with the message opens the copy (the same link, its tip says so). */
function TeamFileLink({ path, at, children }: { path: string; at?: SourceLoc; children: ReactNode }) {
  const t = useT()
  const target = useLinkTarget(path)
  if (target.kind === 'locked') return <LockedFile>{children}</LockedFile>
  const copy = target.kind === 'copy' ? target.copy : null
  const canPreview = previewKind(copy?.name ?? path) !== null
  return (
    <button
      type="button"
      onClick={() => (copy ? openFilePreview(copy) : openTeamFile(path, at))}
      className="not-prose inline rounded-sm text-left font-medium text-accent-text underline decoration-accent-text/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-accent-text"
      title={copy ? t('rooms.fileAttachedCopy') : canPreview ? t('common.preview') : t('preview.unsupportedShort')}
      data-testid="team-file-chip"
      data-copy={copy ? '' : undefined}
    >
      <FileText className="mr-0.5 inline-block size-[0.95em] shrink-0 align-[-0.125em]" aria-hidden />
      {children}
    </button>
  )
}

/** A team file this viewer may not open (a room message's link or picture): its name after a lock, where a link would be.
 * Hover or keyboard focus says why ("열 수 없어요: 옮겨졌거나 지워졌거나 권한이 없어요"); a tap or click says it too (a toast:
 * touch has no tooltip). Nothing of the file is loaded and nothing says whether it exists, so the words name every
 * reason: a file moved after the message was sent is locked too (QA TC-063). */
function LockedFile({ children }: { children: ReactNode }) {
  const t = useT()
  const why = t('rooms.fileNoAccess')
  return (
    <Tooltip label={why} description>
      <button
        type="button"
        onClick={() => toast({ level: 'info', text: why })}
        className="not-prose inline cursor-default rounded-sm text-left text-muted [overflow-wrap:anywhere]"
        data-testid="team-file-text"
      >
        <Lock className="mr-0.5 inline-block size-[0.9em] shrink-0 align-[-0.1em]" aria-hidden data-testid="team-file-lock" />
        {children}
        <span className="sr-only"> ({why})</span>
      </button>
    </Tooltip>
  )
}

/** An image on the team server (answers, shared browser screenshots). A click opens the image viewer (with the other
 * pictures of its chat or room by ← →; elsewhere alone). In a room, one the viewer may not open is its name after a
 * lock, or a link to its copy when that went with the message (the copy's thumbnail is under the message already). */
export function TeamImage({ path, alt, className }: { path: string; alt?: string; className?: string }) {
  const t = useT()
  const [failed, setFailed] = useState(false)
  const target = useLinkTarget(path)
  const asLink = useContext(TeamImagesAsLinks)
  const drawn = target.kind === 'team' && !asLink && isDisplayableImagePath(path) && !failed
  const viewer = useViewerItem(drawn ? (meta) => teamImageItem(path, alt || baseName(path) || t('md.image'), meta) : null)
  if (target.kind === 'locked') return <LockedFile>{alt || baseName(path) || t('md.image')}</LockedFile>
  if (target.kind === 'copy') return <TeamFileLink path={path}>{alt || target.copy.name}</TeamFileLink>
  if (asLink) return <TeamFileLink path={path}>{alt || baseName(path) || t('md.image')}</TeamFileLink>
  if (!isDisplayableImagePath(path) || failed)
    return (
      <button type="button" className="not-prose inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-muted" onClick={() => openTeamFile(path)}>
        <ImageOff size={14} aria-hidden /> {alt || baseName(path) || t('md.image')}
      </button>
    )
  return (
    <Tooltip label={t('md.openImage', { name: alt || baseName(path) })}>
      <button type="button" ref={viewer.ref} className="not-prose my-2 inline-block" onClick={viewer.open} aria-label={t('md.openImage', { name: alt || baseName(path) })} data-testid="md-image">
        <img src={fileUrl(path, 'inline')} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} className={className ?? 'max-h-80 rounded-lg border border-line'} />
      </button>
    </Tooltip>
  )
}

/** A chat upload's thumbnail named in an answer. In text from outside the team folder (TeamImagesAsLinks) it is not
 * loaded by itself either: only its words. */
function AttachmentThumb({ url, alt }: { url: string; alt?: string }) {
  const t = useT()
  if (useContext(TeamImagesAsLinks)) return <span className="text-faint">[{alt || t('md.image')}]</span>
  return <img src={url} alt={alt ?? ''} className="max-h-60 rounded-lg" />
}

/** An external image: not loaded (its URL could carry data out); the person opens it in a new tab if they want (in the
 * phone app it opens in the phone's browser, lib/appWording.ts). */
function ExternalImage({ href, host, alt }: { href: string; host: string; alt?: string }) {
  const t = useT()
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="not-prose my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-muted no-underline hover:bg-hover" title={href}>
      <ExternalLink size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium text-ink">{t('md.externalImage', { host })}</span>
        {alt && <span className="block truncate">{alt}</span>}
        <span className="block">{t(externalImageHintKey(!!mobileApp()))}</span>
      </span>
    </a>
  )
}

const origin = () => (typeof location === 'undefined' ? 'http://localhost' : location.origin)

// defined once: inline component functions are new types on every render, which remounts (and resets) diagrams
const COMPONENTS: Components = {
  table: ({ children }) => <CopyableTable>{children}</CopyableTable>,
  td: ({ node, className, ...props }) => <td {...props} className={clsx(className, isNumberCell(cellText(node)) && 'whitespace-nowrap tabular-nums') || undefined} />,
  a: ({ href, children }) => {
    const l = classifyLink(href, origin())
    if (l.kind === 'team-file') return <TeamFileLink path={l.path} at={l.at}>{children}</TeamFileLink>
    if (l.kind === 'app') return <Link to={l.href}>{children}</Link>
    if (l.kind === 'external')
      return (
        <a href={l.href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
          {children}
        </a>
      )
    return <span>{children}</span>
  },
  pre: ({ node, children }) => {
    const c = codeOf(node)
    if (!c) return <pre className="overflow-x-auto">{children}</pre>
    return c.lang === 'mermaid' ? <MermaidBlock code={c.code} /> : <CodeBlock lang={c.lang} code={c.code} />
  },
  img: ({ src, alt }) => {
    const k = classifyImage(typeof src === 'string' ? src : undefined, origin())
    if (k.kind === 'team-file') return <TeamImage path={k.path} alt={alt} />
    if (k.kind === 'attachment-thumb') return <AttachmentThumb url={k.url} alt={alt} />
    if (k.kind === 'inline-data') return <img src={k.src} alt={alt ?? ''} className="max-h-80 rounded-lg" />
    if (k.kind === 'external') return <ExternalImage href={k.href} host={k.host} alt={alt} />
    return <span className="text-faint">[{alt}]</span>
  },
}
/** An assistant answer's Markdown: the top-level quotes labelQuotes named get a copy button each; other quotes stay
 * plain quotes, as in files, docs, artifacts and the rest of the app. */
const COMPONENTS_ANSWER: Components = {
  ...COMPONENTS,
  blockquote: ({ node, children }) => {
    const label = node?.properties?.dataQuoteLabel
    return typeof label === 'string' ? <CopyableQuote label={label}>{children}</CopyableQuote> : <blockquote>{children}</blockquote>
  },
}

// cjk-friendly: "**마일스톤(◆)**으로" is bold (CommonMark ends emphasis only before punctuation or a space, and Korean
// particles follow the closing ** directly)
export const REMARK = [remarkGfm, remarkCjkFriendly, mathRemark as never]

/** Remove only parsed comments from raw HTML; keep all other HTML escaped by ReactMarkdown as before. */
export function hideHtmlComments() {
  return (tree: Root) => {
    function visit(node: Root | RootContent) {
      if (node.type === 'raw' && node.value.includes('<!--')) {
        const source = node.value
        const comments: { start: number; end: number }[] = []
        function collect(node: Root | RootContent) {
          if (node.type === 'comment') {
            const start = node.position?.start.offset
            const end = node.position?.end.offset
            if (start !== undefined && end !== undefined && source.startsWith('<!--', start)) comments.push({ start, end })
          }
          if ('children' in node) node.children.forEach(collect)
          if (node.type === 'element' && node.content) collect(node.content)
        }
        // Parse for source ranges only: never insert the parsed HTML into the rendered tree. A parser also
        // distinguishes comments from literal <!-- inside attributes, script text, and other raw-text tags.
        collect(fromHtml(source, { fragment: true }))
        for (const { start, end } of comments.sort((a, b) => b.start - a.start)) {
          node.value = node.value.slice(0, start) + node.value.slice(end)
        }
      }
      if ('children' in node) node.children.forEach(visit)
    }
    visit(tree)
  }
}

/** The visible text of a hast node (no markup). */
function hastText(n: Root | RootContent | ElementContent): string {
  if (n.type === 'text') return n.value
  return 'children' in n ? (n.children as RootContent[]).map(hastText).join('') : ''
}
/** Longest name a copy button gets from a heading or a quote's first line. */
const QUOTE_LABEL_MAX = 40

/**
 * Assistant answers only: every top-level quote (a child of the answer itself, never a quote inside a quote or a list)
 * gets the name of its copy button in `data-quote-label`: the heading right before it ("1안 · 혜택 중심"), else its own
 * first line, else its number; a name already used in the answer gets " (2)", " (3)". A quote without the name keeps
 * the plain quote styling (COMPONENTS_ANSWER).
 */
export function labelQuotes() {
  return (tree: Root) => {
    const used = new Map<string, number>()
    let heading: string | null = null
    let n = 0
    for (const c of tree.children) {
      if (c.type === 'text' && !c.value.trim()) continue
      if (c.type === 'element' && /^h[1-6]$/.test(c.tagName)) { heading = hastText(c).trim(); continue }
      if (c.type === 'element' && c.tagName === 'blockquote') {
        n++
        const first = hastText(c).trim().split('\n')[0]!.trim()
        let label = (heading || first || `#${n}`).replace(/\s+/g, ' ')
        if (label.length > QUOTE_LABEL_MAX) label = label.slice(0, QUOTE_LABEL_MAX - 1).trimEnd() + '…'
        const seen = (used.get(label) ?? 0) + 1
        used.set(label, seen)
        c.properties = { ...c.properties, dataQuoteLabel: seen > 1 ? `${label} (${seen})` : label }
      }
      heading = null
    }
  }
}

const REHYPE = [hideHtmlComments, mathRehype as never]
const REHYPE_ANSWER = [hideHtmlComments, labelQuotes, mathRehype as never]

/** Keep the react-markdown default URL check (javascript: etc. become empty), but let our own download links through. */
export function urlTransform(url: string): string {
  if (/^(https?:|mailto:|tel:|\/|#|\.|data:image\/(png|jpeg|gif|webp);)/i.test(url)) return url
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url // relative
  return ''
}

// A size is chosen here, not overridden through className: Tailwind orders the built stylesheet by its own rules, not by
// the order in the class attribute, so of two sizes on one element either may win (leading-7 and prose-h3:text-reading
// the same way). text-reading is 15px, 17px on phones (index.css).
const SIZES = {
  answer: 'text-reading leading-7 prose-h1:text-lg prose-h2:text-base prose-h3:text-reading',
  // (inline code is 0.85em; in small text on a phone that would read under 13px, so there it is the text's size)
  small: 'text-xs leading-5 prose-h1:text-sm prose-h2:text-sm prose-h3:text-xs max-md:prose-code:text-[1em]',
}

/** `copyQuotes`: an assistant answer in the chat, where each top-level quote copies on its own (ad options, drafts).
 * `openable` / `attached`: in a room, the team files this viewer may open and the copies that went with the message.
 * `teamImagesAsLinks`: text from outside the team folder, whose team pictures are links, not loaded. */
export const Markdown = memo(function Markdown({ text, streaming, className, size = 'answer', copyQuotes, openable, attached, teamImagesAsLinks }: { text: string; streaming?: boolean; className?: string; size?: keyof typeof SIZES; copyQuotes?: boolean; openable?: ReadonlySet<string>; attached?: ReadonlyMap<string, PreviewFile>; teamImagesAsLinks?: boolean }) {
  if (openable || attached || teamImagesAsLinks)
    return (
      <OpenableFiles.Provider value={openable ?? null}>
        <AttachedCopies.Provider value={attached ?? null}>
          <TeamImagesAsLinks.Provider value={!!teamImagesAsLinks}>
            <Markdown text={text} streaming={streaming} className={className} size={size} copyQuotes={copyQuotes} />
          </TeamImagesAsLinks.Provider>
        </AttachedCopies.Provider>
      </OpenableFiles.Provider>
    )
  return (
    <div
      className={clsx(
        'answer prose max-w-none break-words prose-headings:mt-4 prose-headings:mb-1.5 prose-headings:font-semibold prose-p:my-2 prose-blockquote:font-normal prose-code:rounded prose-code:bg-subtle prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:box-decoration-clone prose-code:before:content-none prose-code:after:content-none prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-hr:my-4 prose-table:my-0 prose-th:bg-subtle prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        SIZES[size],
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={copyQuotes ? REHYPE_ANSWER : REHYPE} components={copyQuotes ? COMPONENTS_ANSWER : COMPONENTS} urlTransform={urlTransform}>
        {prepareMarkdown(text, streaming)}
      </ReactMarkdown>
    </div>
  )
})
