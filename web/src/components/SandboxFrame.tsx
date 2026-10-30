// An isolated frame for artifacts and HTML / SVG previews (tab 5 "아티팩트 격리 규칙"): sandbox="allow-scripts" only
// (opaque origin: no cookies, storage, popups, forms, top navigation). The frame loads the team server's fixed
// receiver /sandbox/frame (its response CSP is the strict sandbox policy), which says "ready"; only then does this
// component post the document (built by lib/artifacts.ts, meta CSP first) to it. The document never goes in through
// srcdoc or a blob: URL: both would inherit the app's CSP, which then would have to allow inline scripts.
//
// The listener is attached in the same task that inserts the frame (layout effect), and when the receiver has loaded
// without its "ready" reaching us, a "ping" asks for it again: a missed "ready" left the panel empty for good.
//
// Messages are only taken from this frame's own window (event.source). Expected loads: the receiver, then the
// document it wrote (document.close). A further load — or the "leaving" signal of the written document — means it
// tried to navigate away: the frame is reset to about:blank and a notice is shown (a signal only; the app's frame-src
// CSP is what blocks the navigation).
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { cleanStatic, SANDBOX, SANDBOX_FRAME_URL, staticShell } from '../lib/artifacts'
import { useT } from '../i18n'

/** Loads of a frame that stayed put: the receiver, then the document written over it. */
export const EXPECTED_LOADS = 2

export default function SandboxFrame(props: { html: string; title: string; onError?: (message: string) => void; className?: string }) {
  // a new document = a new frame (the receiver takes exactly one document)
  return <Frame key={props.html} {...props} />
}

function Frame({ html, title, onError, className }: { html: string; title: string; onError?: (message: string) => void; className?: string }) {
  const t = useT()
  const ref = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const sent = useRef(false)
  const [escaped, setEscaped] = useState(false)
  const errRef = useRef(onError)
  errRef.current = onError

  const stop = () => {
    const f = ref.current
    if (f) f.src = 'about:blank'
    setEscaped(true)
  }
  const stopRef = useRef(stop)
  stopRef.current = stop

  useLayoutEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const win = ref.current?.contentWindow
      if (!win || e.source !== win) return
      const d = e.data as { source?: string; type?: string; message?: string } | null
      if (d?.source !== 'mycel-frame') return
      if (d.type === 'ready' && !sent.current) {
        sent.current = true
        // the frame's origin is opaque ("null"), so the target origin can only be "*"; the receiver checks that the
        // message comes from its parent
        win.postMessage({ source: 'mycel-host', type: 'render', html }, '*')
      } else if (d.type === 'error') errRef.current?.(String(d.message ?? '').slice(0, 2000))
      else if (d.type === 'leaving' && sent.current) stopRef.current()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [html])

  if (escaped)
    return (
      <div role="alert" className="flex items-start gap-2 p-6 text-sm text-warn">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
        {t('artifact.navigationBlocked')}
      </div>
    )

  return (
    <iframe
      ref={ref}
      title={title}
      sandbox={SANDBOX}
      src={SANDBOX_FRAME_URL}
      referrerPolicy="no-referrer"
      allow=""
      data-testid="sandbox-frame"
      className={className ?? 'h-full w-full border-0 bg-white'}
      onLoad={() => {
        loads.current += 1
        if (loads.current > EXPECTED_LOADS) stop()
        // the receiver is up but its "ready" didn't arrive (or came before we listened): ask again
        else if (loads.current === 1 && !sent.current) ref.current?.contentWindow?.postMessage({ source: 'mycel-host', type: 'ping' }, '*')
      }}
    />
  )
}

/**
 * A page shown without running anything (confidential chats outside the desktop app, lib/artifacts.ts
 * frameRunsScripts): no allow-scripts, so nothing in it runs, whatever it contains. The page is parsed here (DOMParser
 * runs nothing and loads nothing), cleaned (cleanStatic: no link hints, link targets or addresses, refresh, frames …)
 * and its nodes are copied into an empty document with its own CSP; it is never turned back into markup and parsed
 * again, so what is shown is exactly the cleaned tree. allow-same-origin only lets this component write into the frame.
 */
export function StaticFrame({ html, title, gutter, className }: { html: string; title: string; gutter?: boolean; className?: string }) {
  const t = useT()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="flex shrink-0 items-start gap-2 border-b border-line bg-subtle px-3 py-2 text-xs text-muted" data-testid="static-notice">
        <ShieldCheck size={14} className="mt-px shrink-0" aria-hidden />
        {t('artifact.staticNotice')}
      </p>
      <StaticDocument key={html} html={html} title={title} gutter={gutter} className={className} />
    </div>
  )
}

function StaticDocument({ html, title, gutter, className }: { html: string; title: string; gutter?: boolean; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  // per document: a frame that reloads (moved in the page) starts as the empty shell again
  const filled = useRef(new WeakSet<Document>())
  const fill = () => {
    const doc = ref.current?.contentDocument
    if (!doc || filled.current.has(doc)) return
    filled.current.add(doc)
    const page = cleanStatic(new DOMParser().parseFromString(html, 'text/html'))
    for (const a of ['lang', 'dir', 'class', 'style']) {
      const v = page.documentElement.getAttribute(a)
      if (v !== null) doc.documentElement.setAttribute(a, v)
    }
    for (const n of Array.from(page.head.childNodes)) doc.head.appendChild(doc.importNode(n, true))
    // a <frameset> page has no body left after cleaning: it shows empty
    if (page.body) doc.body.replaceWith(doc.importNode(page.body, true))
  }
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={staticShell({ gutter })}
      referrerPolicy="no-referrer"
      allow=""
      data-testid="static-frame"
      className={className ?? 'min-h-0 w-full flex-1 border-0 bg-white'}
      onLoad={fill}
    />
  )
}
