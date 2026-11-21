// The story's end, its ways on (overlay.tsx): "Now try it yourself" (the live demo, web/demo/live.ts) as the primary
// button while the gate can take a visitor, the plans link next to it; while it cannot (busy, paused, down, slow), one
// line that the live demo is busy and the plans link alone, as before. In the guide line's end line and in the end popup.
import { Button } from '../src/components/ui'
import type { LiveState } from './live'
import { beacon } from './beacon'

const trySent = () => beacon('try_click')
const signupSent = () => beacon('cta_click', 'signup:demo_end')

export interface EndLinks {
  signup: { label: string; url: string }
  /** the story's live demo, if it has one (`retry`: the busy line's small "Try again") */
  live?: { label: string; busy: string; url: string; retry?: string }
  state: LiveState
  /** the busy line's "Try again": the gate's status is read again (web/demo/live.ts useLiveDemo) */
  onRetry?: () => void
}

/** "Try again" after the busy line: small, a link-looking button (the gate may take a visitor a minute later) */
function Retry(e: EndLinks & { testId: string }) {
  if (!e.live?.retry || !e.onRetry) return null
  return <button type="button" className="demo-live-retry" onClick={e.onRetry} data-testid={e.testId}>{e.live.retry}</button>
}

const offered = (e: EndLinks) => !!e.live && e.state !== 'busy'

/** the end line's links (demo.css .demo-end-line) */
export function EndLineLinks(e: EndLinks) {
  if (offered(e)) {
    return (
      <span className="demo-end-links">
        {e.state === 'available'
          ? <a className="demo-next" href={e.live!.url} onClick={trySent} data-testid="demo-try-live">{e.live!.label} →</a>
          : <span className="demo-next demo-wait" aria-busy="true" data-testid="demo-try-live-checking">{e.live!.label}</span>}
        <a className="demo-plans" href={e.signup.url} target="_blank" rel="noopener" onClick={signupSent} data-testid="demo-signup">{e.signup.label} →</a>
      </span>
    )
  }
  return (
    <>
      {/* the busy line and its Try again on one line (a phone puts the line on its own row) */}
      {e.live && (
        <span className="demo-live-busy">
          <span role="status" data-testid="demo-live-busy">{e.live.busy}</span>{' '}
          <Retry {...e} testId="demo-live-retry" />
        </span>
      )}
      <a className="demo-next" href={e.signup.url} target="_blank" rel="noopener" onClick={signupSent} data-testid="demo-signup">{e.signup.label} →</a>
    </>
  )
}

/** the end popup's buttons (the app's Modal footer): Look around, the plans, and the live demo first when offered */
export function EndPopupButtons(e: EndLinks & { close: string; restart: string; onClose: () => void; onRestart: () => void; go?: (url: string) => void; open?: (url: string) => void }) {
  const go = e.go ?? ((url: string) => location.assign(url))
  const open = e.open ?? ((url: string) => void window.open(url, '_blank', 'noopener'))
  if (offered(e)) {
    return (
      <>
        <Button onClick={e.onClose} data-testid="demo-popup-close">{e.close}</Button>
        <Button onClick={() => { signupSent(); open(e.signup.url) }} data-testid="demo-popup-signup">{e.signup.label}</Button>
        <Button variant="primary" busy={e.state === 'checking'} disabled={e.state !== 'available'} onClick={() => { trySent(); go(e.live!.url) }} data-testid="demo-popup-try-live">{e.live!.label}</Button>
      </>
    )
  }
  return (
    <>
      <Button onClick={e.onRestart} data-testid="demo-popup-restart">{e.restart}</Button>
      <Button onClick={e.onClose} data-testid="demo-popup-close">{e.close}</Button>
      <Button variant="primary" onClick={() => { signupSent(); open(e.signup.url) }} data-testid="demo-popup-signup">{e.signup.label}</Button>
    </>
  )
}

/** the popup's line while the live demo cannot take a visitor (under the recap) */
export function EndPopupBusy(e: EndLinks) {
  if (!e.live || e.state !== 'busy') return null
  return (
    <p className="mt-2 text-sm text-muted">
      <span role="status" data-testid="demo-popup-live-busy">{e.live.busy}</span>{' '}
      <Retry {...e} testId="demo-popup-live-retry" />
    </p>
  )
}
