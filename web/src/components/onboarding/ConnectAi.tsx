// "AI 연결" wherever no AI answers (docs/DECISIONS.md "W2 — AI connection first"): one way in, the same everywhere.
// The welcome step shows ConnectAiPanel: the three ways at once, "Claude 구독 연결" (추천) first, then "ChatGPT 구독 연결"
// and "API 키로 연결". Home shows one quiet line under the greeting instead (NoAiCard, QA TC-5447): one button
// ("Claude 연결하기"), the other ways under "다른 방법".
// The line above the composer and a failed answer show ConnectAiButton ("AI 연결하기"; a member's "내 AI 연결하기"): one
// button where there is room for one line, opening on the recommended way, with "다른 방법" in the dialog for the rest.
// The setup row and the end screen of the welcome steps (`panel`) open a dialog titled "AI 연결" with the same three
// ways as the welcome step (the walk of PR #100: the row said "AI 연결하기" and opened "계정 추가" on Claude alone).
// Each opens Admin › AI connections' own AddCredential dialog in its simple form (the whole team, named after the kind,
// the provider's terms in one line; no password). No connection
// logic here. When the dialog is done, GET /api/me/ai-access is asked again: every "no AI" place reads that store, so
// they all move on together; a connection saved that cannot answer yet says so.
import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import type { CredentialKind } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { useLocale, useT, type MessageKey } from '../../i18n'
import { useAiAccess } from '../../store/aiAccess'
import { toast } from '../../store/ui'
import { MenuButton } from '../rooms/MenuButton'
import { Button, ErrorNote, Modal, Skeleton } from '../ui'

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

/** The simple dialog: one way chosen (`kind`), the key ways (`onlyKinds`), or every way. */
function Dialog({ ways, personal, kind, onlyKinds, onClose, onDone }: { ways: Ways; personal: boolean; kind?: CredentialKind; onlyKinds?: CredentialKind[]; onClose: () => void; onDone: () => void }) {
  return (
    <Suspense fallback={null}>
      <AddCredential simple personal={personal} allowedKinds={ways.allowedKinds} gateway={ways.gateway ?? undefined} sharedSubscriptions={ways.sharedSubscriptions}
        groups={[]} users={[]} initialKind={kind} onlyKinds={onlyKinds} onClose={onClose} onDone={onDone} />
    </Suspense>
  )
}

/** The ways ConnectAiPanel offers, in order: each opens the dialog on its kind, or on the API keys the team allows. */
type Way = { id: 'claude' | 'chatgpt' | 'keys'; label: MessageKey; kind?: CredentialKind; onlyKinds?: CredentialKind[] }
const KEY_KINDS: CredentialKind[] = ['anthropic-api-key', 'openai-api-key']

/** A subscription is offered while the team allows sharing one (the dialog would refuse it otherwise); a key way while
 * the team allows either key. */
function waysShown(w: Ways): Way[] {
  const shown: Way[] = []
  if (claudeOf(w, false)) shown.push({ id: 'claude', label: 'welcome.ai.claude', kind: 'anthropic-oauth' })
  if (w.sharedSubscriptions && w.allowedKinds.includes('chatgpt')) shown.push({ id: 'chatgpt', label: 'welcome.ai.chatgpt', kind: 'chatgpt' })
  const keys = KEY_KINDS.filter((k) => w.allowedKinds.includes(k))
  if (keys.length) shown.push({ id: 'keys', label: 'welcome.ai.keys', onlyKinds: keys })
  return shown
}

const quietLink = 'font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink disabled:opacity-50'

/** The team's ways, the dialog of the one chosen, and what happens after it (does AI answer now?): ConnectAiPanel's and
 * Home's line's. */
function useTeamWays(onConnected?: () => void) {
  const t = useT()
  const locale = useLocale()
  const [ways, setWays] = useState<Ways | null>(null)
  const [open, setOpen] = useState<Way | null>(null)
  const [checking, setChecking] = useState<Way['id'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    waysOf(false).then((w) => live && setWays(w), (e) => live && setError(errorText(e, locale, t('error.network'))))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const done = async () => {
    const used = open?.id ?? null
    setOpen(null)
    setChecking(used)
    setError(null)
    try {
      if (!(await answersNow())) setError(t('welcome.ai.notYet'))
      else onConnected?.()
    } finally {
      setChecking(null)
    }
  }
  const dialog = open && ways && <Dialog ways={ways} personal={false} kind={open.kind} onlyKinds={open.onlyKinds} onClose={() => setOpen(null)} onDone={() => void done()} />
  return { ways, shown: ways ? waysShown(ways) : [], setOpen, checking, error, dialog }
}

/**
 * The welcome step's way to connect (and the "AI 연결" dialog's): the ways at once, one stack of equal rows. The first
 * is the main button ("Claude 구독 연결", marked 추천), the others bordered; each opens the dialog on its way. No line to
 * Admin › AI accounts under them (removed with fix/onboarding-after-setup: an expert page in a non-developer's first
 * screen; other providers stay in Admin, where an owner who looks for them finds them). The team's connection: the
 * owner's or an admin's. Home has its own one line (NoAiCard).
 */
export function ConnectAiPanel({ disabled, onConnected }: { disabled?: boolean; onConnected?: () => void }) {
  const t = useT()
  const { ways, shown, setOpen, checking, error, dialog } = useTeamWays(onConnected)
  return (
    <div className="space-y-3" data-testid="connect-ai">
      {!ways && !error ? <Skeleton lines={2} /> : (
        <>
          {shown.length > 0 && (
            <div className="flex flex-col gap-2 sm:max-w-sm" data-testid="welcome-ai-ways">
              {shown.map((w, i) => (
                <Button key={w.id} variant={i === 0 ? 'primary' : 'secondary'} className="w-full" busy={checking === w.id} disabled={disabled || checking !== null} onClick={() => setOpen(w)} data-testid={`welcome-ai-${w.id}`}>
                  <span className="min-w-0 flex-1 truncate text-left">{t(w.label)}</span>
                  {w.id === 'claude' && <span className="text-xs font-normal opacity-80" data-testid="welcome-ai-recommended">{t('welcome.ai.recommended')}</span>}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {dialog}
    </div>
  )
}

/**
 * One button that opens the same dialog: "AI 연결하기" (the team's, Claude chosen while the team allows a shared Claude
 * subscription, else every way) or, with `personal`, "내 AI 연결하기" (one's own, every way). `quiet`: a text link, for a
 * second way under another action. `row`: a plain button with these classes and `children` as its content (the setup
 * row, SetupRow.tsx). `panel` (the team's; the setup row and the welcome steps' end screen): a dialog
 * titled "AI 연결" with the welcome step's three ways (ConnectAiPanel), closed once AI answers.
 */
export function ConnectAiButton({ personal = false, panel = false, size = 'sm', quiet, label, row, children, ...props }: {
  personal?: boolean; panel?: boolean; size?: 'sm' | 'md'; quiet?: boolean; label?: MessageKey; row?: string; children?: ReactNode
} & Record<`data-${string}`, string>) {
  const t = useT()
  const locale = useLocale()
  const [ways, setWays] = useState<Ways | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const text = t(label ?? (personal ? 'aiAccess.connectOwn' : 'aiAccess.connectTeam'))
  const start = async () => {
    if (panel && !personal) { setPanelOpen(true); return }
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
      {row ? (
        <button type="button" className={row} disabled={loading || checking} aria-busy={loading || checking || undefined} onClick={() => void start()} {...props}>{children ?? text}</button>
      ) : quiet ? (
        <button type="button" className={quietLink} disabled={loading || checking} onClick={() => void start()} {...props}>{text}</button>
      ) : (
        <Button size={size} variant="primary" busy={loading || checking} onClick={() => void start()} {...props}>{text}</Button>
      )}
      {ways && <Dialog ways={ways} personal={personal} kind={!personal && claudeOf(ways, false) ? 'anthropic-oauth' : undefined} onClose={() => setWays(null)} onDone={() => void done()} />}
      <Modal open={panelOpen} onClose={() => setPanelOpen(false)} title={t('aiConnect.dialogTitle')}>
        <div data-testid="connect-ai-dialog">
          <p className="mb-4 text-sm text-balance text-muted">{t('welcome.ai.why')}</p>
          <ConnectAiPanel onConnected={() => setPanelOpen(false)} />
        </div>
      </Modal>
    </>
  )
}

/** "다른 방법 ⌄" and "내 AI 연결하기": a quiet text action beside Home's one button */
const quietAction = 'inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-sm font-medium text-muted transition hover:text-ink disabled:opacity-50 max-md:min-h-11'

/**
 * Home while no AI answers this person (docs/DECISIONS.md "Y — Home shows one thing at a time"; QA TC-5447, the owner:
 * the old card was "garbage"): ONE quiet line under the greeting, right over the box, in place of the top row (the
 * welcome steps' "continue" row, the goal card) and of the suggestions, which would all fail. No frame, no heading, one
 * button: the greeting stays the page's hero, the line is the step before the box.
 * The owner and admins: "AI를 연결하면 바로 시작할 수 있어요" [Claude 연결하기] 다른 방법 ⌄, the menu holding the
 * team's other ways (ChatGPT 구독 연결, API 키로 연결), each opening the same dialog as before. A team that does not
 * share subscriptions: its first way (the API keys) is the button. Anyone else: "아직 쓸 수 있는 AI가 없어요"
 * [팀장·관리자에게 연결 요청하기] (one notice per owner and admin, then "알렸어요"), and, where the team allows personal
 * connections, a quiet "내 AI 연결하기" beside it. On a computer the line and its actions sit in one row; on a phone
 * the line, then the actions under it, centred like the greeting.
 */
export function NoAiCard() {
  const t = useT()
  const { action, requested, sending, failed, ask } = useAiAccess()
  const row = 'flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-center'
  const frame = 'mb-6 max-md:mt-5 max-md:mb-0'
  if (action === 'connect_team') return <ConnectTeamLine className={clsx(frame, row)} />
  return (
    <section role="status" className={clsx(frame, row)} data-testid="no-ai-card" data-action={action}>
      <p className="text-sm leading-6 text-pretty text-muted max-md:basis-full" data-testid="no-ai-line">{t(requested ? 'aiAccess.banner.asked' : 'home.noAi.member')}</p>
      {!requested && (
        <Button variant="primary" busy={sending} onClick={() => void ask()} data-testid="ai-access-button" data-action="ask_owner">
          {sending ? t('aiAccess.asking') : t('home.noAi.ask')}
        </Button>
      )}
      {action === 'connect_own' && <ConnectAiButton personal row={quietAction} data-testid="no-ai-own" />}
      {failed && <p role="alert" className="basis-full text-xs text-danger">{t('aiAccess.askFailed')}</p>}
    </section>
  )
}

/** The owner's and an admin's line: the first of the team's ways as the one button, the rest under "다른 방법". */
function ConnectTeamLine({ className }: { className: string }) {
  const t = useT()
  return (
    <section aria-labelledby="no-ai-line" className={className} data-testid="no-ai-card" data-action="connect_team">
      <p id="no-ai-line" className="text-sm leading-6 text-pretty text-muted max-md:basis-full" data-testid="no-ai-line">{t('home.noAi.connect')}</p>
      <TeamWaysButtons />
    </section>
  )
}

/** The team's ways as Home's no-AI line has them ("Claude 연결하기" first, the rest under "다른 방법"), each opening its
 * dialog: the line, and the My setup card's AI row (MemberWelcome.tsx). `small`: a card row's button (44 px on a phone). */
export function TeamWaysButtons({ small }: { small?: boolean }) {
  const t = useT()
  const { ways, shown, setOpen, checking, error, dialog } = useTeamWays()
  const [first, ...rest] = shown
  return (
    <>
      {!ways && !error && <span aria-hidden className={clsx('w-32 animate-pulse rounded-lg bg-subtle', small ? 'h-8' : 'h-9')} />}
      {first && (
        <Button variant="primary" size={small ? 'sm' : undefined} className={small ? 'max-md:min-h-11' : undefined} busy={checking === first.id} disabled={checking !== null} onClick={() => setOpen(first)} data-testid={`welcome-ai-${first.id}`}>
          {first.id === 'claude' ? t('home.noAi.claude') : t(first.label)}
        </Button>
      )}
      {rest.length > 0 && (
        <MenuButton bare startAligned label={t('welcome.ai.other')} testId="no-ai-other" buttonClassName={quietAction}
          icon={<>{t('welcome.ai.other')}<ChevronDown size={15} aria-hidden /></>}
          items={rest.map((w) => ({ label: t(w.label), onSelect: () => setOpen(w), testId: `welcome-ai-${w.id}`, disabled: checking !== null }))} />
      )}
      {error && <div className="basis-full text-left"><ErrorNote>{error}</ErrorNote></div>}
      {dialog}
    </>
  )
}
