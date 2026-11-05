// "AI 연결" wherever no AI answers (docs/DECISIONS.md "W2 — AI connection first"): one way in, the same everywhere.
// The welcome step and Home's card show ConnectAiPanel (one primary "Claude 구독 연결" while the team allows a shared
// Claude subscription, the other ways folded under "다른 방법"); the line above the composer and a failed answer show
// ConnectAiButton ("AI 연결하기"; a member's "내 AI 연결하기"). Each opens Admin › AI connections' own AddCredential
// dialog in its simple form (the whole team, named after the kind, the provider's terms in one line, the password again
// for a team connection; one's own as in Settings). No connection logic here. When the dialog is done, GET
// /api/me/ai-access is asked again: every "no AI" place reads that store, so they all move on together; a connection
// saved that cannot answer yet says so.
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CredentialKind } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { toast } from '../../store/ui'
import { Button, ErrorNote, Skeleton } from '../ui'

// the dialog comes with Admin's page: loaded when it is first opened, not with Home
const AddCredential = lazy(() => import('../../pages/admin/Credentials').then((m) => ({ default: m.AddCredential })))

interface Ways { allowedKinds: CredentialKind[]; gateway: { label: string } | null | undefined; sharedSubscriptions: boolean }

/** what the dialog offers: the team's ways (Admin › AI connections), or one's own (Settings › AI connections) */
async function waysOf(personal: boolean): Promise<Ways> {
  if (personal) {
    const r = await api.call(API.myCredentials)
    return { allowedKinds: r.allowedKinds, gateway: r.anthropicGateway, sharedSubscriptions: false }
  }
  const r = await api.call(API.listCredentials)
  return { allowedKinds: r.allowedKinds, gateway: r.anthropicGateway, sharedSubscriptions: r.sharedSubscriptions }
}

/** a shared Claude subscription is the one primary way while the team allows it (a personal one always may be) */
const claudeOf = (w: Ways, personal: boolean) => w.allowedKinds.includes('anthropic-oauth') && (personal || w.sharedSubscriptions)

/** After the dialog: does AI answer now? (a key the provider could not check yet counts: it is tried at the first
 * question) */
async function answersNow(): Promise<boolean> {
  await useAiAccess.getState().load(true)
  return useAiAccess.getState().usable
}

/** The simple dialog: Claude chosen, or every way. */
function Dialog({ ways, personal, claude, onClose, onDone }: { ways: Ways; personal: boolean; claude: boolean; onClose: () => void; onDone: () => void }) {
  return (
    <Suspense fallback={null}>
      <AddCredential simple personal={personal} allowedKinds={ways.allowedKinds} gateway={ways.gateway ?? undefined} sharedSubscriptions={ways.sharedSubscriptions}
        groups={[]} users={[]} initialKind={claude ? 'anthropic-oauth' : undefined} onClose={onClose} onDone={onDone} />
    </Suspense>
  )
}

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

/**
 * The welcome step's way to connect (and Home's card for the owner): one primary "Claude 구독 연결", the other ways
 * folded under "다른 방법" (open when there is no Claude button): the same dialog with every way, and the AI engines
 * page for other providers (OpenRouter …). The team's connection: the owner's.
 */
export function ConnectAiPanel({ disabled }: { disabled?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [ways, setWays] = useState<Ways | null>(null)
  const [open, setOpen] = useState<'claude' | 'other' | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    waysOf(false).then((w) => live && setWays(w), (e) => live && setError(errorText(e, locale, t('error.network'))))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const claude = !!ways && claudeOf(ways, false)
  const done = async () => {
    setOpen(null)
    setChecking(true)
    setError(null)
    try {
      if (!(await answersNow())) setError(t('welcome.ai.notYet'))
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="space-y-4" data-testid="connect-ai">
      {!ways && !error ? <Skeleton lines={2} /> : (
        <div className="space-y-4">
          {claude && (
            <Button variant="primary" className="max-sm:w-full" busy={checking} disabled={disabled} onClick={() => setOpen('claude')} data-testid="welcome-ai-claude">
              {t('welcome.ai.claude')}
            </Button>
          )}
          <details className="group text-sm" open={!claude || undefined} data-testid="welcome-ai-other">
            <summary className="cursor-pointer text-muted select-none hover:text-ink">{t('welcome.ai.other')}</summary>
            <div className="mt-3 space-y-3 border-l border-line pl-3">
              <p className="text-[13px] text-muted">{t('welcome.ai.otherDesc')}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button size="sm" variant={claude ? 'secondary' : 'primary'} disabled={!ways || disabled} onClick={() => setOpen('other')} data-testid="welcome-ai-other-open">
                  {t('welcome.ai.otherOpen')}
                </Button>
                <Link to="/admin/engines" className={quietLink} data-testid="welcome-ai-engines">{t('welcome.ai.engines')}</Link>
              </div>
            </div>
          </details>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {open && ways && <Dialog ways={ways} personal={false} claude={open === 'claude'} onClose={() => setOpen(null)} onDone={() => void done()} />}
    </div>
  )
}

/**
 * One button that opens the same dialog: "AI 연결하기" (the team's, Claude chosen while the team allows a shared Claude
 * subscription, else every way) or, with `personal`, "내 AI 연결하기" (one's own, every way). `quiet`: a text link, for a
 * second way under another action.
 */
export function ConnectAiButton({ personal = false, size = 'sm', quiet, label, ...props }: {
  personal?: boolean; size?: 'sm' | 'md'; quiet?: boolean; label?: MessageKey
} & Record<`data-${string}`, string>) {
  const t = useT()
  const locale = useLocale()
  const [ways, setWays] = useState<Ways | null>(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const text = t(label ?? (personal ? 'aiAccess.connectOwn' : 'aiAccess.connectTeam'))
  const start = async () => {
    setLoading(true)
    try {
      setWays(await waysOf(personal))
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    } finally {
      setLoading(false)
    }
  }
  const done = async () => {
    setWays(null)
    setChecking(true)
    try {
      if (!(await answersNow())) toast({ level: 'warn', text: t('welcome.ai.notYet') })
    } finally {
      setChecking(false)
    }
  }
  return (
    <>
      {quiet ? (
        <button type="button" className={quietLink} disabled={loading || checking} onClick={() => void start()} {...props}>{text}</button>
      ) : (
        <Button size={size} variant="primary" busy={loading || checking} onClick={() => void start()} {...props}>{text}</Button>
      )}
      {ways && <Dialog ways={ways} personal={personal} claude={!personal && claudeOf(ways, false)} onClose={() => setWays(null)} onDone={() => void done()} />}
    </>
  )
}
