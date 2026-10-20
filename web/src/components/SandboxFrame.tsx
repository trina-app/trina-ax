// An isolated frame for artifacts and HTML / SVG previews (tab 5 "아티팩트 격리 규칙"): sandbox="allow-scripts" only
// (opaque origin: no cookies, storage, popups, forms, top navigation). The frame loads the team server's fixed
// receiver /sandbox/frame (its response CSP is the strict sandbox policy), which says "ready"; only then does this
// component post the document (built by lib/artifacts.ts, meta CSP first) to it. The document never goes in through
// srcdoc or a blob: URL: both would inherit the app's CSP, which then would have to allow inline scripts.
//
// Messages are only taken from this frame's own window (event.source). Expected loads: the receiver, then the
// document it wrote (document.close). A further load — or the "leaving" signal of the written document — means it
// tried to navigate away: the frame is reset to about:blank and a notice is shown (a signal only; the app's frame-src
// CSP is what blocks the navigation).
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SANDBOX, SANDBOX_FRAME_URL } from '../lib/artifacts'
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

  useEffect(() => {
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
      }}
    />
  )
}
