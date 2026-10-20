// QR code of an invite link (drawn as SVG from the module matrix; no external service).
import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

export default function QrCode({ text, size = 176, label }: { text: string; size?: number; label: string }) {
  const { n, path } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 2},${r + 2}h1v1h-1z`
    return { n: count + 4, path: d }
  }, [text])
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded bg-white">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  )
}
