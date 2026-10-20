// Answer Markdown (GFM + math + Mermaid + highlighted code), ported from Saram's ui.tsx / markdownExtras.tsx and
// extended from chat-proto: code blocks with language colours, copy and download; tables that copy into
// Sheets/Excel; links to team files open the preview panel; external images never load by themselves.
import 'katex/dist/katex.min.css'
import clsx from 'clsx'
import type { Element, ElementContent } from 'hast'
import { Check, Copy, Download, Eye, ImageOff, ExternalLink } from 'lucide-react'
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { Link } from 'react-router-dom'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { fileUrl, saveBlob, startDownload } from '../lib/api'
import { classifyImage, classifyLink, isDisplayableImagePath, prepareMarkdown } from '../lib/markdown'
import { previewKind } from '../lib/preview'
import { openTeamFile } from '../lib/sidePanel'
import { baseName } from '../lib/paths'
import { useT } from '../i18n'
import { useCopy } from './ui'

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
    const dark = document.documentElement.classList.contains('dark')
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral' })
    return m
  }))
const drawn = new Map<string, string>()

/** A Mermaid diagram in an answer. Shows the source while it is still being written or doesn't parse. */
export function MermaidBlock({ code }: { code: string }) {
  const t = useT()
  const [svg, setSvg] = useState<string | null>(() => drawn.get(code) ?? null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (drawn.has(code)) {
      setSvg(drawn.get(code)!)
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
        const m = await loadMermaid()
        return (await m.render(`mmd-${Math.random().toString(36).slice(2)}`, code)).svg
      }
      try {
        const out = await draw().catch(async () => {
          await new Promise((r) => setTimeout(r, 700))
          return draw()
        })
        drawn.set(code, out)
        if (live) {
          setSvg(out)
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
  }, [code])
  if (svg && !failed)
    return (
      // securityLevel strict: mermaid sanitizes labels (DOMPurify) and turns off click handlers
      <div role="img" aria-label={t('md.diagram')} className="not-prose my-3 flex justify-center overflow-x-auto rounded-lg border border-line bg-white p-4 [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
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
    <div className="not-prose group my-3 overflow-hidden rounded-lg bg-code-bg text-code-ink">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1 text-xs text-[#b9b3a8]">
        <span>{lang ?? t('md.code')}</span>
        <span className="flex items-center gap-1">
          <button type="button" className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-white" onClick={() => void copy(code)} aria-label={copied ? t('common.copied') : t('md.copyCode')}>
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            <span>{copied ? t('common.copied') : t('common.copy')}</span>
          </button>
          <button type="button" className="rounded p-1 hover:bg-white/10 hover:text-white" aria-label={t('md.downloadCode')} title={t('md.downloadCode')} onClick={() => saveBlob(new Blob([code], { type: 'text/plain;charset=utf-8' }), `code.${LANG_EXT[lang ?? ''] ?? 'txt'}`)}>
            <Download size={13} aria-hidden />
          </button>
        </span>
      </div>
      <pre className="m-0 overflow-x-auto p-3 text-[13px] leading-5">
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
    <div className="group relative my-3">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table ref={ref} className="m-0 min-w-full text-sm">
          {children}
        </table>
      </div>
      <button
        type="button"
        onClick={copy}
        title={t('md.copyTableHint')}
        className="absolute -top-2.5 right-2 flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs font-medium text-muted shadow-sm transition hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
      >
        {copied ? <Check size={12} className="text-ok" aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? t('common.copied') : t('md.copyTable')}
      </button>
    </div>
  )
}

// ---------------- links and images ----------------
/** A file the AI made or mentioned: a chip that opens the preview (or downloads what can't be previewed). */
function TeamFileLink({ path, children }: { path: string; children: ReactNode }) {
  const t = useT()
  const canPreview = previewKind(path) !== null
  return (
    <span className="not-prose my-1 inline-flex max-w-full items-stretch overflow-hidden rounded-xl border border-line bg-surface align-middle text-sm font-medium text-ink shadow-sm">
      <button type="button" onClick={() => (canPreview ? openTeamFile(path) : startDownload(fileUrl(path), baseName(path)))} className="inline-flex min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-hover" title={canPreview ? t('common.preview') : t('common.download')}>
        {canPreview ? <Eye size={15} className="shrink-0 text-accent-text" aria-hidden /> : <Download size={15} className="shrink-0 text-accent-text" aria-hidden />}
        <span className="break-all">{children}</span>
      </button>
      {canPreview && (
        <button type="button" onClick={() => startDownload(fileUrl(path), baseName(path))} className="border-l border-line px-2.5 text-muted hover:bg-hover" aria-label={t('common.download')} title={t('common.download')}>
          <Download size={14} aria-hidden />
        </button>
      )}
    </span>
  )
}

/** An image on the team server (answers, shared browser screenshots). A click opens the preview panel. */
export function TeamImage({ path, alt, className }: { path: string; alt?: string; className?: string }) {
  const t = useT()
  const [failed, setFailed] = useState(false)
  if (!isDisplayableImagePath(path) || failed)
    return (
      <button type="button" className="not-prose inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-muted" onClick={() => openTeamFile(path)}>
        <ImageOff size={14} aria-hidden /> {alt || baseName(path) || t('md.image')}
      </button>
    )
  return (
    <button type="button" className="not-prose my-2 inline-block" onClick={() => openTeamFile(path)} aria-label={t('md.openImage', { name: alt || baseName(path) })}>
      <img src={fileUrl(path, 'inline')} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} className={className ?? 'max-h-80 rounded-lg border border-line'} />
    </button>
  )
}

/** An external image: not loaded (its URL could carry data out); the person opens it in a new tab if they want. */
function ExternalImage({ href, host, alt }: { href: string; host: string; alt?: string }) {
  const t = useT()
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="not-prose my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2 text-xs text-muted no-underline hover:bg-hover" title={href}>
      <ExternalLink size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium text-ink">{t('md.externalImage', { host })}</span>
        {alt && <span className="block truncate">{alt}</span>}
        <span className="block">{t('md.externalImageHint')}</span>
      </span>
    </a>
  )
}

const origin = () => (typeof location === 'undefined' ? 'http://localhost' : location.origin)

// defined once: inline component functions are new types on every render, which remounts (and resets) diagrams
const COMPONENTS: Components = {
  table: ({ children }) => <CopyableTable>{children}</CopyableTable>,
  a: ({ href, children }) => {
    const l = classifyLink(href, origin())
    if (l.kind === 'team-file') return <TeamFileLink path={l.path}>{children}</TeamFileLink>
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
    if (k.kind === 'attachment-thumb') return <img src={k.url} alt={alt ?? ''} className="max-h-60 rounded-lg" />
    if (k.kind === 'inline-data') return <img src={k.src} alt={alt ?? ''} className="max-h-80 rounded-lg" />
    if (k.kind === 'external') return <ExternalImage href={k.href} host={k.host} alt={alt} />
    return <span className="text-faint">[{alt}]</span>
  },
}

const REMARK = [remarkGfm, mathRemark as never]
const REHYPE = [mathRehype as never]

/** Keep the react-markdown default URL check (javascript: etc. become empty), but let our own download links through. */
function urlTransform(url: string): string {
  if (/^(https?:|mailto:|tel:|\/|#|\.|data:image\/(png|jpeg|gif|webp);)/i.test(url)) return url
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url // relative
  return ''
}

export const Markdown = memo(function Markdown({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div
      className={clsx(
        'answer prose max-w-none text-[15px] leading-7 break-words prose-headings:mt-4 prose-headings:mb-1.5 prose-headings:font-semibold prose-h1:text-lg prose-h2:text-base prose-h3:text-[15px] prose-p:my-2 prose-blockquote:font-normal prose-code:rounded prose-code:bg-subtle prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-hr:my-4 prose-table:my-0 prose-th:bg-subtle prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS} urlTransform={urlTransform}>
        {prepareMarkdown(text, streaming)}
      </ReactMarkdown>
    </div>
  )
})
