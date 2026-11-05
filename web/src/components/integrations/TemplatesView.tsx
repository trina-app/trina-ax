// Connection templates (server/src/integrations/connections/templates.ts): an admin registers a service once, and
// each member it is for connects it with their own key or sign-in.
// - Settings › MCP, "From your team": the templates shared with this member. Not connected yet: the service and Connect,
//   which opens the member's own-key dialog (AnswerDialog.tsx OwnKeyDialog) with the template filled in. Connected: the
//   member's own connection, like any other (check again, sign in, tools, edit their key, disconnect).
// - Admin › MCP: a template on one line, "Template · N connected", who it is for, edit and delete. The admin never sees
//   a member's key or who connected, only how many.
import { Globe, Pencil, Plug, Trash2, Waypoints } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Group, Integration, IntegrationTemplate, MyIntegrationTemplate, User } from '@mycel/shared/api'
import { api, API, errorText } from '../../lib/api'
import { connectorFor } from '../../lib/connectors'
import { isEmptyAccess } from '../../lib/integrations'
import { useLocale, useT } from '../../i18n'
import { toast } from '../../store/ui'
import { Badge, Button, IconButton, confirmDialog } from '../ui'
import { OwnKeyDialog } from './AnswerDialog'
import { ConnectorLogo } from './ConnectorsView'
import { IntegrationRow, type IntegrationActions } from './IntegrationRow'

function ServiceIcon({ url, kind }: { url: string; kind: Integration['kind'] }) {
  const listed = connectorFor(url)
  const KindIcon = kind === 'mcp' ? Waypoints : Globe
  return listed ? <ConnectorLogo c={listed} className="size-9" /> : (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
      <KindIcon size={16} aria-hidden />
    </span>
  )
}

/** Settings › MCP: the templates shared with this member. `version` changes: load again. `query` filters by name. */
export function MyTemplates({ version, query, actions, onEdit, onConnected }: {
  version: number
  query: string
  actions: IntegrationActions
  onEdit: (i: Integration) => void
  onConnected: (i: Integration, signIn: { window: Window | null } | null) => void
}) {
  const t = useT()
  const [items, setItems] = useState<MyIntegrationTemplate[]>([])
  const [open, setOpen] = useState<MyIntegrationTemplate | null>(null)
  const gen = useRef(0)
  const load = async () => {
    const g = ++gen.current
    try {
      const r = await api.call(API.listIntegrationTemplates)
      if (g === gen.current) setItems(r.items)
    } catch {
      // an older server has no templates; the rest of the page works without them
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
  const q = query.trim().toLocaleLowerCase()
  const shown = q ? items.filter((x) => x.name.toLocaleLowerCase().includes(q)) : items
  if (!shown.length) return null
  return (
    <section aria-labelledby="integrations-from-team" data-testid="integrations-from-team">
      <h3 id="integrations-from-team" className="text-sm font-semibold">{t('integrations.template.fromTeam')}</h3>
      <p className="mt-0.5 mb-2 text-xs text-muted">{t('integrations.template.fromTeamHint')}</p>
      <ul className="-mx-2 divide-y divide-line" data-testid="integrations-from-team-list">
        {shown.map((x) => x.connection ? (
          <IntegrationRow key={x.id} i={x.connection} actions={actions} onEdit={() => onEdit(x.connection!)} />
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
              <Plug size={14} aria-hidden /> {t('integrations.template.connect')}
            </Button>
          </li>
        ))}
      </ul>
      {open && (
        <OwnKeyDialog
          src={open}
          title={t('integrations.template.connectTitle', { name: open.name })}
          intro={t('integrations.template.connectIntro', { by: open.createdBy?.name ?? t('integrations.template.yourTeam') })}
          submit={(body) => api.call(API.connectIntegrationTemplate, { params: { id: open.id }, body })}
          onClose={() => setOpen(null)}
          onConnected={(i, signIn) => {
            setOpen(null)
            void load()
            onConnected(i, signIn)
          }}
        />
      )}
    </section>
  )
}

/** Admin › MCP: one template. Who it is for and who made it under the name; edit and delete on the line. */
export function TemplateRow({ tpl, groups, users, onEdit, onDeleted }: {
  tpl: IntegrationTemplate
  groups: Group[]
  users: User[]
  onEdit: () => void
  onDeleted: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const a = tpl.access
  const names = [...a.groups.map((id) => groups.find((g) => g.id === id)?.name ?? '?'), ...a.users.map((id) => users.find((u) => u.id === id)?.name ?? '?')]
  const who = a.everyone ? t('integrations.access.everyone') : names.join(', ')
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
            <span className="inline-flex" data-testid="template-badge"><Badge tone="accent">{t('integrations.template.badge', { n: tpl.connected })}</Badge></span>
            {isEmptyAccess(a) && <Badge tone="warn">{t('integrations.users.nobody')}</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted" data-testid="template-admin-line">
            {isEmptyAccess(a) ? t('integrations.template.eachOwn') : t('integrations.template.forWho', { who })}
          </span>
        </span>
      </div>
      <IconButton label={t('common.edit')} onClick={onEdit} data-testid="template-edit"><Pencil size={15} /></IconButton>
      <IconButton label={t('common.delete')} danger onClick={() => void remove()} data-testid="template-delete"><Trash2 size={15} /></IconButton>
    </li>
  )
}
