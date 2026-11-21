// "Connect your tools" ("내 도구 연결"), the My setup card's first row (MemberWelcome.tsx; docs/decisions/20261120-my-
// setup-card.md): the team's recommended tools first, then the usual ones (lib/myTools.ts), each with its own [연결]
// for the person's own account:
// - a listed service (Notion …) connects in place, the welcome tools step's own way: the person's own connection with
//   the list's address and sign-in (POST /api/integrations, nothing to type), its sign-in in the window reserved during
//   the click;
// - Google Drive or a Google app opens its page in Settings › Connectors, where its own sign-in is (the account check
//   included). Settings is a dialog over Home: closing it reads the lists again.
// A tool the team connected for everyone says "팀 연결됨" with no button; one of theirs says "연결됨". The row is done
// once any of the person's own connections works (the server's `steps.tools`; a new one here marks it at once), or when
// every tool it offers is the team's for everyone (nothing left to connect: `onCovered`).
import { Check } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { API, type Integration } from '@mycel/shared/api'
import { api, errorText } from '../../lib/api'
import { connectorHref, connectorLogo, CONNECTORS, CONNECTORS_HOME, servesAt, type Connector } from '../../lib/connectors'
import { builtInLogo, builtInName, isBuiltIn } from '../../lib/googleApps'
import { myTools, type ToolFacts, type ToolOffer } from '../../lib/myTools'
import { useRealPath } from '../../lib/realPath'
import { integrationsChanged } from '../../store/live'
import { useLocale, useT } from '../../i18n'
import { Button } from '../ui'
import { LogoTile } from '../integrations/ConnectorsView'
import { reserveSignInWindow, useSignIn } from '../integrations/IntegrationRow'

const tap = 'max-md:min-h-11'
const WAITING = new Set(['starting', 'pending', 'exchanging'])
const works = (i: Integration) => i.status === 'connected' && (i.auth !== 'oauth' || i.hasSecret)

/** The person's lists, read once and again when the connections change or Settings closes; null while unknown. */
function useToolFacts() {
  const [facts, setFacts] = useState<(ToolFacts & { mine: Integration[] }) | null>(null)
  const load = useCallback(async () => {
    const [list, drive, google] = await Promise.all([
      api.call(API.listIntegrations).catch(() => null),
      api.call(API.myDriveConnection).catch(() => null),
      api.call(API.myGoogleApps).catch(() => null),
    ])
    if (!list) return setFacts((f) => f ?? null)
    const listed = (scope: 'personal' | 'team') => new Set(list.items.filter((i) => i.scope === scope && !i.templateId && works(i)).flatMap((i) => CONNECTORS.filter((c) => servesAt(c, i.url)).map((c) => c.id)))
    setFacts({
      // the team's recommended tools (TeamSettings.recommendedTools, shared/src/api/team-tools.ts); a server without
      // them leaves it out: the usual tools alone
      recommended: list.recommendedTools,
      // a Drive an admin shares with this person counts as the team's, like a Google app's shared account
      drive: drive ? { configured: drive.configured, mine: drive.status === 'connected', team: !!drive.teamShares?.length } : null,
      google: (google?.apps ?? []).map((a) => ({ id: a.id, available: a.available, mine: a.status === 'connected', team: a.shared?.status === 'connected' })),
      listedAllowed: list.personalAllowed,
      listedMine: listed('personal'),
      listedTeam: listed('team'),
      mine: list.items.filter((i) => i.scope === 'personal' && !i.templateId),
    })
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => integrationsChanged.on(() => void load()), [load])
  // back from Settings › Connectors (a dialog over Home): read again
  const real = useRealPath()
  const was = useRef(real)
  useEffect(() => {
    if (was.current !== real && !real.startsWith('/settings')) void load()
    was.current = real
  }, [real, load])
  return { facts, load }
}

/** The tools under the row's words. `onMine`: one of theirs works now (the row is done); `onCovered`: every tool it
 * offers is connected by the team for everyone (nothing left to connect: done too). */
export function MyToolsList({ onMine, onCovered }: { onMine: () => void; onCovered?: () => void }) {
  const t = useT()
  const locale = useLocale()
  const navigate = useNavigate()
  const { facts, load } = useToolFacts()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  // connections made here, before the lists are read again
  const [made, setMade] = useState<Integration[]>([])
  const signIn = useSignIn(() => { void load() })
  const tools = facts ? myTools(facts) : []
  const anyMine = tools.some((x) => x.state === 'mine')
  const told = useRef(false)
  useEffect(() => { if (anyMine && !told.current) { told.current = true; onMine() } }, [anyMine, onMine])
  const allTeam = tools.length > 0 && tools.every((x) => x.state === 'team')
  const covered = useRef(false)
  useEffect(() => { if (allTeam && !covered.current) { covered.current = true; onCovered?.() } }, [allTeam, onCovered])
  if (!facts || !tools.length) return null
  const own = (c: Connector) => [...made, ...facts.mine].find((i) => servesAt(c, i.url))
  const connect = async (c: Connector) => {
    // the window first, during the click (one opened after the server answers is blocked as a popup)
    const w = reserveSignInWindow()
    setErrors((e) => ({ ...e, [c.id]: '' }))
    const there = own(c)
    if (there) { void signIn.start(there.id, w); return }
    setBusy(c.id)
    try {
      const i = await api.call(API.createIntegration, { body: { kind: 'mcp', name: c.name, url: c.url, auth: 'oauth', writePolicy: 'ask' } })
      setMade((m) => [i, ...m.filter((x) => x.id !== i.id)])
      if (i.status === 'needs_auth') void signIn.start(i.id, w)
      else { w?.close(); void load() }
    } catch (e) {
      w?.close()
      setErrors((x) => ({ ...x, [c.id]: errorText(e, locale, t('error.network')) }))
    } finally { setBusy(null) }
  }
  const row = (o: ToolOffer) => {
    const c = o.kind === 'listed' ? CONNECTORS.find((x) => x.id === o.id)! : null
    const name = c ? c.name : isBuiltIn(o.id) ? builtInName(o.id) : o.id
    const logo = c ? connectorLogo(c) : isBuiltIn(o.id) ? builtInLogo(o.id) : ''
    const i = c ? own(c) : undefined
    const flow = i && signIn.state?.id === i.id ? signIn.state : null
    const waiting = !!flow && WAITING.has(flow.state)
    const note = waiting ? t('myTools.signingIn') : flow ? flow.reason || t('myTools.failed') : (c && errors[c.id]) || ''
    return (
      <li key={o.id} className="flex min-h-9 items-center gap-2.5 py-1" data-testid="my-tools-item" data-id={o.id} data-state={waiting ? 'signing-in' : o.state}>
        <LogoTile src={logo} className="size-7 rounded-md p-1" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink">{name}</p>
          {note && <p role={waiting ? 'status' : 'alert'} className={`text-label break-words ${waiting ? 'text-muted' : 'text-warn'}`} data-testid="my-tools-note">{note}</p>}
        </div>
        {o.state === 'mine' ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted" data-testid="my-tools-mine"><Check size={14} className="text-ok" aria-hidden />{t('drive.status.connected')}</span>
        ) : o.state === 'team' ? (
          <span className="shrink-0 text-xs text-muted" data-testid="my-tools-team">{t('myTools.team')}</span>
        ) : waiting ? (
          <Button size="sm" variant="ghost" className={tap} onClick={signIn.cancel} data-testid="my-tools-cancel">{t('common.cancel')}</Button>
        ) : (
          <Button size="sm" className={tap} busy={!!c && busy === c.id} disabled={!!busy}
            onClick={() => (c ? void connect(c) : navigate(connectorHref(o.id)))}
            aria-label={`${t('aiApps.connect')}: ${name}`} data-testid="my-tools-connect">
            {flow ? t('common.retry') : t('aiApps.connect')}
          </Button>
        )}
      </li>
    )
  }
  return (
    <div className="mt-1.5" data-testid="my-tools">
      <ul>{tools.map(row)}</ul>
      <button type="button" onClick={() => navigate(CONNECTORS_HOME)} className="mt-1 text-label font-medium text-muted underline decoration-line-strong underline-offset-4 hover:text-ink" data-testid="my-tools-more">
        {t('myTools.more')}
      </button>
    </div>
  )
}
