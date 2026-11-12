// A link made while the app is open at this computer's own address (an SSH tunnel to a server that has no team address
// yet: http://127.0.0.1:47820/invite/…) opens on this computer only. Where such a link is shown, say so and what to do
// (QA TC-211: the invite screen gave the 127.0.0.1 link with no word).
import { AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'

/** A link whose host is this computer only: 127.x.x.x, localhost (and *.localhost), ::1. */
export function isThisComputerOnly(url: string): boolean {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]' || host === '::1'
}

export function LocalLinkNote({ url, className = '' }: { url: string; className?: string }) {
  const t = useT()
  if (!isThisComputerOnly(url)) return null
  const path = [t('admin.title'), t('admin.system'), t('system.connection')].join(' › ')
  return (
    <p role="note" className={`flex items-start gap-1.5 text-xs text-warn ${className}`} data-testid="local-link-note">
      <AlertTriangle size={14} className="mt-px shrink-0" aria-hidden />
      <span>{t('links.thisComputerOnly', { path })}</span>
    </p>
  )
}
