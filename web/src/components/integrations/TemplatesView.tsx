// Connection templates (server/src/integrations/connections/templates.ts): an admin registers a service once, and
// each member it is for connects it with their own key or sign-in.
// - Settings › Connectors, "From <team>" (FromTeam): what the team provides to this person, in one block above their own
//   connections. The team's connections they may use (company accounts) are read-only there, with their state for this
//   person ("Ready", or what is wrong); an admin also sees the ones not for them ("Off for you") and one Manage link to
//   Admin › Connectors. The templates shared with them: not connected yet, "Connect your account", which opens the
//   member's own-key dialog (AnswerDialog.tsx OwnKeyDialog) with the template filled in; connected, the member's own
//   connection, "Ready", with their own key's controls in its details (check again, sign in, tools, edit their key,
//   disconnect). ?template=<id> (an inbox notice, a scheduled run that needed it) opens that template's Connect.
// - Admin › Connectors: a template on one line, who it is for (one chip), "Template · N connected", edit and delete. "N
//   connected" opens who it is for, each with whether they connected it and when, or whether their key stopped working.
//   The admin never sees a member's key or anything the service returned.
import { Globe, Pencil, Plug, Trash2, Waypoints } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Group, Integration, IntegrationTemplate, IntegrationTemplateMember, MyIntegrationTemplate, User } from '@mycel/shared/api'
import { api, API, errorText, isApiError } from '../../lib/api'
import { connectorFor } from '../../lib/connectors'
import { isEmptyAccess } from '../../lib/integrations'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { formatDate } from '../../lib/format'
import { Badge, Button, IconButton, Modal, Skeleton, confirmDialog } from '../ui'
import { OwnKeyDialog } from './AnswerDialog'
import { ConnectorLogo, matchesQuery } from './ConnectorsView'
import { AudienceChip, IntegrationRow, type IntegrationActions } from './IntegrationRow'

function ServiceIcon({ url, kind }: { url: string; kind: Integration['kind'] }) {
  const listed = connectorFor(url)
  const KindIcon = kind === 'mcp' ? Waypoints : Globe
  return listed ? <ConnectorLogo c={listed} className="size-9" /> : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
      <KindIcon size={16} aria-hidden />
    </span>
  )
}

/** What this person gets from a connection the team provides, on its line in "From <team>". */
function StateChip({ state }: { state: 'ready' | 'off' }) {
  const t = useT()
  return <span className="inline-flex shrink-0" data-testid="from-team-state" data-state={state}><Badge tone={state === 'ready' ? 'ok' : 'neutral'}>{t(state === 'ready' ? 'connectors.state.ready' : 'connectors.state.off')}</Badge></span>
}

/** Settings › Connectors, "From <team>": the team's connections this person may use (`team`, read-only), for an admin
 * also the ones not for them (`offForMe`), and the templates shared with them, in one block sorted by name. `team` and
 * `offForMe` are null until they have loaded. `latest`: the page's list, where a connection made from a template is
 * kept up to date (check again, a tool switch), so its row shows that and not the copy the templates came with. `version` changes: the templates load again. `query` filters by name (and a
 * connection's address). `manage`: an admin's link to Admin › Connectors. `onShown` tells the page whether the block
 * shows anything, once both lists are in (the page says "nothing matches", and that nothing is connected, only when
 * nothing on it shows). */
export function FromTeam({ teamName, team, offForMe = [], latest, manage, version, query, actions, onEdit, onConnected, onShown }: {
  teamName: string
  team: Integration[] | null
  offForMe?: Integration[] | null
  latest?: Integration[]
  manage?: boolean
  version: number
  query: string
  actions: IntegrationActions
  onEdit: (i: Integration) => void
  onConnected: (i: Integration, signIn: { window: Window | null } | null) => void
  onShown?: (shown: boolean) => void
}) {
  const t = useT()
  const [items, setItems] = useState<MyIntegrationTemplate[]>([])
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState<MyIntegrationTemplate | null>(null)
  const gen = useRef(0)
  const load = async (): Promise<MyIntegrationTemplate[] | null> => {
    const g = ++gen.current
    try {
      const r = await api.call(API.listIntegrationTemplates)
      if (g === gen.current) setItems(r.items)
      return r.items
    } catch {
      // an older server has no templates; the rest of the page works without them
      return null
    } finally {
      if (g === gen.current) setLoaded(true)
    }
  }
  /** Connect as the member saw the template (its version): changed since, the server says so (409) and the dialog
   * shows the template as it is now, for the member to check and connect again. */
  const connect = async (tpl: MyIntegrationTemplate, body: { secret?: string; writePolicy: Integration['writePolicy'] }) => {
    try {
      return await api.call(API.connectIntegrationTemplate, { params: { id: tpl.id }, body: { ...body, version: tpl.version } })
    } catch (e) {
      if (isApiError(e, 'conflict')) {
        const fresh = (await load())?.find((x) => x.id === tpl.id)
        if (fresh) setOpen(fresh)
        else setOpen(null)
      }
      throw e
    }
  }
  const [params, setParams] = useSearchParams()
  const asked = params.get('template')
  useEffect(() => {
    void load().then((list) => {
      // ?template=<id>: that template's Connect (a notice or a scheduled run sent the person here); once only
      if (!asked || !list) return
      const hit = list.find((x) => x.id === asked)
      if (hit && (!hit.connection || hit.connection.status === 'needs_auth')) setOpen(hit)
      setParams((p) => { const n = new URLSearchParams(p); n.delete('template'); return n }, { replace: true })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
  const q = query.trim().toLocaleLowerCase()
  const rows: { name: string; row: ReactNode }[] = [
    ...(team ?? []).filter((i) => matchesQuery(i, query)).map((i) => ({ name: i.name, row: (
      // the company's account: nothing to manage here; ready once it works, else what is wrong with it
      <IntegrationRow key={i.id} i={i} actions={actions} onEdit={() => {}} readOnly state={i.status === 'connected' ? <StateChip state="ready" /> : undefined} />
    ) })),
    ...(offForMe ?? []).filter((i) => matchesQuery(i, query)).map((i) => ({ name: i.name, row: (
      <IntegrationRow key={i.id} i={i} actions={actions} onEdit={() => {}} readOnly state={<StateChip state="off" />} />
    ) })),
    ...items.filter((x) => !q || x.name.toLocaleLowerCase().includes(q)).map((x) => {
      const conn = x.connection && (latest?.find((i) => i.id === x.connection!.id) ?? x.connection)
      return { name: x.name, row: conn ? (
      // their own connection, made from the template: their own key's controls are in its details
      <IntegrationRow key={x.id} i={conn} actions={actions} onEdit={() => onEdit(conn)} state={conn.status === 'connected' ? <StateChip state="ready" /> : undefined} />
    ) : (
      <li key={x.id} className="flex items-center gap-3 p-2" data-testid="template-row" data-name={x.name}>
        <ServiceIcon url={x.url} kind={x.kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={x.name}>{x.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted" title={x.notes ?? undefined}>
            {x.notes || t(x.auth === 'oauth' ? 'integrations.template.signInLine' : 'integrations.template.keyLine')}
          </span>
        </span>
        <Button size="sm" variant="primary" className="shrink-0" onClick={() => setOpen(x)} data-testid="template-connect">
          <Plug size={14} aria-hidden /> {t('connectors.state.connect')}
        </Button>
      </li>
    ) }
    }),
  ].sort((a, b) => a.name.localeCompare(b.name))
  const ready = loaded && team !== null && offForMe !== null
  const any = ready && rows.length > 0
  useEffect(() => { if (ready) onShown?.(any) }, [ready, any, onShown])
  return (
    <>
      {any && (
        <section aria-labelledby="integrations-from-team" data-testid="integrations-from-team">
          <div className="mb-1 flex items-center gap-3">
            <h3 id="integrations-from-team" className="min-w-0 truncate text-sm font-semibold">{t('connectors.fromTeam', { team: teamName })}</h3>
            {manage && <Link to="/admin/connectors" className="ml-auto shrink-0 text-sm font-medium text-accent-text hover:underline" data-testid="from-team-manage">{t('connectors.manage')}</Link>}
          </div>
          <ul className="-mx-2 divide-y divide-line" data-testid="integrations-from-team-list">{rows.map((r) => r.row)}</ul>
        </section>
      )}
      {open && (
        <OwnKeyDialog
          src={open}
          title={t('integrations.template.connectTitle', { name: open.name })}
          intro={t('integrations.template.connectIntro')}
          submit={(body) => connect(open, body)}
          onClose={() => setOpen(null)}
          onConnected={(i, signIn) => {
            setOpen(null)
            void load()
            onConnected(i, signIn)
          }}
        />
      )}
    </>
  )
}

/** Admin › MCP, a template's "N connected": who it is for, each with whether they connected it and when, or whether
 * their key stopped working. Names and states only. */
function TemplateMembers({ tpl, onClose }: { tpl: IntegrationTemplate; onClose: () => void }) {
  const t = useT()
  const locale = useLocale()
  const [items, setItems] = useState<IntegrationTemplateMember[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.call(API.listIntegrationTemplateMembers, { params: { id: tpl.id } })
      .then((r) => { if (live) setItems(r.items) })
      .catch((e) => { if (live) setError(errorText(e, locale, t('error.network'))) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.id])
  const tone = (s: IntegrationTemplateMember['state']) => s === 'connected' ? 'ok' as const : s === 'not_connected' ? 'neutral' as const : 'warn' as const
  return (
    <Modal open onClose={onClose} title={t('integrations.template.membersTitle', { name: tpl.name })} footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <p className="text-xs text-muted">{t('integrations.template.membersHint')}</p>
      {error && <p className="mt-3 text-sm text-danger" role="alert">{error}</p>}
      {!items && !error && <div className="mt-3"><Skeleton lines={3} /></div>}
      {items && !items.length && <p className="mt-3 text-sm text-muted">{t('integrations.users.nobody')}</p>}
      {items && items.length > 0 && (
        <ul className="mt-3 divide-y divide-line" data-testid="template-members">
          {items.map((m) => (
            <li key={m.user.id} className="flex items-center gap-3 py-2" data-testid="template-member" data-state={m.state}>
              <span className="min-w-0 flex-1 truncate text-sm" title={m.user.name}>{m.user.name}</span>
              {m.since && m.state === 'connected' && <span className="shrink-0 text-xs text-muted">{formatDate(m.since, locale)}</span>}
              <Badge tone={tone(m.state)}>{t(`integrations.template.member.${m.state}`)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/** Admin › Connectors: one template. Who it is for in a chip after the name (AudienceChip, as a team connection), that
 * each member connects their own under it; edit and delete on the line. `groups` and `users`: null until loaded. */
export function TemplateRow({ tpl, groups, users, onEdit, onDeleted }: {
  tpl: IntegrationTemplate
  groups: Group[] | null
  users: User[] | null
  onEdit: () => void
  onDeleted: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const a = tpl.access
  const [members, setMembers] = useState(false)
  const remove = async () => {
    const ok = await confirmDialog({
      title: t('integrations.template.deleteTitle', { name: tpl.name }),
      body: t('integrations.template.deleteBody', { n: tpl.connected }),
      confirm: t('common.delete'),
      danger: true,
    })
    if (!ok) return
    try {
      await api.call(API.deleteIntegrationTemplate, { params: { id: tpl.id } })
      toast({ level: 'success', text: t('integrations.template.deleted') })
      onDeleted()
    } catch (e) {
      toast({ level: 'error', text: errorText(e, locale, t('error.network')) })
    }
  }
  return (
    <li className="flex items-center gap-1 py-1" data-testid="template-admin-row" data-name={tpl.name}>
      <div className="flex min-w-0 flex-1 items-center gap-3 p-2">
        <ServiceIcon url={tpl.url} kind={tpl.kind} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="max-w-full truncate text-sm font-medium" title={tpl.name}>{tpl.name}</span>
            <AudienceChip access={a} groups={groups} users={users} />
            <button type="button" className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={() => setMembers(true)}
              aria-haspopup="dialog" title={t('integrations.template.membersOpen')} data-testid="template-badge">
              <Badge tone="accent">{t('integrations.template.badge', { n: tpl.connected })}</Badge>
            </button>
            {isEmptyAccess(a) && <Badge tone="warn">{t('integrations.users.nobody')}</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted" data-testid="template-admin-line">{t('integrations.template.eachOwn')}</span>
        </span>
      </div>
      <IconButton label={t('common.edit')} onClick={onEdit} data-testid="template-edit"><Pencil size={15} /></IconButton>
      <IconButton label={t('common.delete')} danger onClick={() => void remove()} data-testid="template-delete"><Trash2 size={15} /></IconButton>
      {members && <TemplateMembers tpl={tpl} onClose={() => setMembers(false)} />}
    </li>
  )
}
