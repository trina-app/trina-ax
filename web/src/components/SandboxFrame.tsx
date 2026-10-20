// An isolated frame for artifacts and HTML / SVG previews: sandbox="allow-scripts" only (opaque origin: no cookies,
// storage, popups, forms, top navigation), document through srcdoc with the CSP first (lib/artifacts.ts).
// If the frame loads a second time it tried to navigate away: it is reset to about:blank and a notice is shown
// (a signal only; the app's frame-src CSP is what blocks the navigation).
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { SANDBOX } from '../lib/artifacts'
import { useT } from '../i18n'

export default function SandboxFrame({ html, title, onError, className }: { html: string; title: string; onError?: (message: string) => void; className?: string }) {
  const t = useT()
  const ref = useRef<HTMLIFrameElement>(null)
  const loads = useRef(0)
  const [escaped, setEscaped] = useState(false)
  const errRef = useRef(onError)
  errRef.current = onError

  useEffect(() => {
    loads.current = 0
    setEscaped(false)
  }, [html])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return
      const d = e.data as { source?: string; type?: string; message?: string } | null
      if (d?.source === 'mycel-frame' && d.type === 'error') errRef.current?.(String(d.message ?? ''))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

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
      srcDoc={html}
      referrerPolicy="no-referrer"
      allow=""
      className={className ?? 'h-full w-full border-0 bg-white'}
      onLoad={() => {
        loads.current += 1
        if (loads.current > 1) {
          const f = ref.current
          if (f) {
            f.removeAttribute('srcdoc')
            f.src = 'about:blank'
          }
          setEscaped(true)
        }
      }}
    />
  )
}
