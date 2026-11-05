// Connection templates (docs/INTEGRATIONS.md "Templates"): an admin registers a service once for the team, and each
// member it is for connects it with their own key or sign-in. Many services give a key its owner's rights and log every
// call under that person's name, so one shared team key would let everyone's AI act as the key's owner. A template
// holds the service (kind, name, address, how it signs in, the key's header, a note) and who it is for, never a key.
// A member's connection made from it is their own (personal) connection, made through the same create path as one they
// add themselves (service.ts create: the same checks, the key sealed for the member, the same audit), with the
// template's address, sign-in method and header fixed: the member changes only their key or sign-in and the write rule
// (service.ts update), so a key only ever goes to the address the admin registered. It is usable only while the
// template covers its member (store.ts mayUse). The admin never sees a key, only how many members connected.
// A new address, sign-in method or header on the template, or deleting the template, deletes the members' connections
// (and so their keys; OAuth sign-ins are revoked); a change of who it is for deletes the connections of members it no
// longer covers. Nothing here holds, returns or logs a key.
import { INTEGRATION_TEMPLATES_MAX, type Integration, type IntegrationAccess, type IntegrationTemplate, type IntegrationTemplateAnswer, type IntegrationTemplateInput, type IntegrationTemplatePatch, type Locale, type MyIntegrationTemplate } from '@mycel/shared/api'
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../../context'
import { newId } from '../../db'
import { audit } from '../../admin/audit'
import { fail } from '../../http/errors'
import { cleanNotes, fieldError, integrationsOf, normUrl, obviouslyPrivate, oneLine } from './service'
import { activeUser, bareUrl, getRow, isAdmin, selectRows, templateCovers, view, type Row, type Viewer } from './store'
import { say } from './text'

interface TemplateRow {
  id: string; created_by: string | null; kind: 'mcp' | 'http'; name: string; url: string; auth: 'bearer' | 'header' | 'oauth'
  auth_header: string | null; notes: string | null; version: number; created_at: string; updated_at: string
}
const COLUMNS = 'id, created_by, kind, name, url, auth, auth_header, notes, version, created_at, updated_at'
const SHOWS = /[^\p{Cc}\p{Cf}\p{Z}\p{DI}\u{2800}]/u

export function getTemplate(db: Database, id: string): TemplateRow | null {
  return db.query(`SELECT ${COLUMNS} FROM integration_templates WHERE id = ?`).get(id) as TemplateRow | null
}
export function templateAccess(db: Database, id: string): IntegrationAccess {
  const rows = db.query('SELECT subject_type, subject_id FROM integration_template_access WHERE template_id = ? ORDER BY subject_type, subject_id').all(id) as { subject_type: string; subject_id: string }[]
  return { everyone: rows.some((r) => r.subject_type === 'everyone'), groups: rows.filter((r) => r.subject_type === 'group').map((r) => r.subject_id), users: rows.filter((r) => r.subject_type === 'user').map((r) => r.subject_id) }
}
function setTemplateAccess(db: Database, id: string, a: IntegrationAccess): void {
  db.query('DELETE FROM integration_template_access WHERE template_id = ?').run(id)
  const ins = db.query('INSERT OR IGNORE INTO integration_template_access (template_id, subject_type, subject_id) VALUES (?,?,?)')
  if (a.everyone) ins.run(id, 'everyone', '')
  for (const g of new Set(a.groups)) ins.run(id, 'group', g)
  for (const u of new Set(a.users)) ins.run(id, 'user', u)
}
/** the members' connections made from a template */
const madeFrom = (db: Database, id: string) => db.query(`${selectRows(db)} WHERE template_id = ?`).all(id) as Row[]
const auditDetail = (t: Pick<TemplateRow, 'kind' | 'name' | 'url' | 'auth'>, more: Record<string, unknown> = {}) => ({ kind: t.kind, name: t.name, host: new URL(t.url).host, auth: t.auth, ...more })

export class ConnectionTemplates {
  constructor(readonly ctx: AppContext) {}
  private get db() { return this.ctx.db }
  private get svc() { return integrationsOf(this.ctx) }
  private now() { return new Date(this.svc.now()).toISOString() }
  private person(id: string | null) {
    return id ? this.db.query('SELECT id, name FROM users WHERE id = ?').get(id) as { id: string; name: string } | null : null
  }

  private adminView(t: TemplateRow): IntegrationTemplate {
    const connected = (this.db.query('SELECT count(*) AS n FROM integrations WHERE template_id = ? AND secret_enc IS NOT NULL').get(t.id) as { n: number }).n
    return {
      id: t.id, kind: t.kind, name: t.name, url: t.url, auth: t.auth, authHeader: t.auth_header, notes: t.notes, access: templateAccess(this.db, t.id),
      connected, createdBy: this.person(t.created_by), createdAt: t.created_at, updatedAt: t.updated_at,
    }
  }

  /** Members' connections whose member the template no longer covers (a rule or a group changed) go, with their keys.
   * Using one is refused before this runs (store.ts mayUse); this keeps no key for someone who may not use it. */
  async sweep(templateId?: string): Promise<void> {
    const rows = (templateId ? madeFrom(this.db, templateId) : this.db.query(`${selectRows(this.db)} WHERE template_id IS NOT NULL`).all() as Row[])
      .filter((r) => !getTemplate(this.db, r.template_id!) || !templateCovers(this.db, r.template_id!, r.owner_user_id!))
    if (rows.length) await this.svc.dropFromTemplate(rows, null, 'not_covered')
  }

  // ---------------- admins ----------------
  async listTeam(viewer: Viewer): Promise<IntegrationTemplate[]> {
    if (!isAdmin(viewer.role)) fail('forbidden')
    await this.sweep()
    const rows = this.db.query(`SELECT ${COLUMNS} FROM integration_templates ORDER BY name, id`).all() as TemplateRow[]
    return rows.map((t) => this.adminView(t))
  }

  private check(L: Locale, v: { name: string; url: string; auth: TemplateRow['auth']; kind: TemplateRow['kind']; authHeader?: string | null; access?: IntegrationAccess }) {
    if (!SHOWS.test(oneLine(v.name))) fieldError(L, 'name', 'requestNoName')
    if (v.auth === 'oauth' && v.kind !== 'mcp') fieldError(L, 'auth', 'oauthMcpOnly')
    if (obviouslyPrivate(normUrl(v.url))) fieldError(L, 'url', 'private_address')
    if (v.access) {
      const groups = new Set((this.db.query('SELECT id FROM groups').all() as { id: string }[]).map((g) => g.id))
      const users = new Set((this.db.query('SELECT id FROM users WHERE deleted_at IS NULL').all() as { id: string }[]).map((u) => u.id))
      const bad = [...v.access.groups.filter((g) => !groups.has(g)), ...v.access.users.filter((u) => !users.has(u))]
      if (bad.length) fieldError(L, 'access', 'unknownSubjects', { list: bad.slice(0, 5).join(', ') })
    }
    return v.auth === 'header' ? this.svc.headerName(v.authHeader ?? null, L) : null
  }

  create(viewer: Viewer, input: IntegrationTemplateInput, L: Locale): IntegrationTemplate {
    if (!isAdmin(viewer.role)) fail('forbidden')
    const n = (this.db.query('SELECT count(*) AS n FROM integration_templates').get() as { n: number }).n
    if (n >= INTEGRATION_TEMPLATES_MAX) fail('conflict', say('templateTooMany', L, { n: INTEGRATION_TEMPLATES_MAX }))
    const authHeader = this.check(L, input)
    const at = this.now()
    const t: TemplateRow = {
      id: newId(), created_by: viewer.id, kind: input.kind, name: oneLine(input.name), url: normUrl(input.url), auth: input.auth, auth_header: authHeader,
      notes: cleanNotes(input.notes), version: 1, created_at: at, updated_at: at,
    }
    this.db.transaction(() => {
      this.db.query(`INSERT INTO integration_templates (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(t.id, t.created_by, t.kind, t.name, t.url, t.auth, t.auth_header, t.notes, t.version, t.created_at, t.updated_at)
      setTemplateAccess(this.db, t.id, input.access)
    })()
    audit(this.db, { actor: viewer.id, action: 'integration_template.create', target: t.id, detail: auditDetail(t, { access: templateAccess(this.db, t.id) }) })
    return this.adminView(t)
  }

  async update(viewer: Viewer, id: string, patch: IntegrationTemplatePatch, L: Locale): Promise<IntegrationTemplate> {
    if (!isAdmin(viewer.role)) fail('forbidden')
    const t = getTemplate(this.db, id) ?? fail('not_found')
    const next: TemplateRow = { ...t }
    if (patch.name !== undefined) next.name = oneLine(patch.name)
    if (patch.url !== undefined) next.url = normUrl(patch.url)
    if (patch.auth !== undefined) next.auth = patch.auth
    if (patch.notes !== undefined) next.notes = cleanNotes(patch.notes)
    if (next.auth === 'header') next.auth_header = patch.authHeader !== undefined ? patch.authHeader : t.auth_header
    else next.auth_header = null
    next.auth_header = this.check(L, { name: next.name, url: next.url, auth: next.auth, kind: next.kind, authHeader: next.auth_header, access: patch.access })
    // a key is never sent to another address or in another way than the member connected it for
    const moved = next.url !== t.url || next.auth !== t.auth || next.auth_header !== t.auth_header
    const changed = (['name', 'url', 'auth', 'auth_header', 'notes'] as const).filter((k) => next[k] !== t[k])
    const before = templateAccess(this.db, id)
    const at = this.now()
    this.db.transaction(() => {
      const r = this.db.query('UPDATE integration_templates SET name=?, url=?, auth=?, auth_header=?, notes=?, version=version+1, updated_at=? WHERE id=? AND version=?')
        .run(next.name, next.url, next.auth, next.auth_header, next.notes, at, id, t.version)
      if (!r.changes) fail('conflict')
      if (patch.access) setTemplateAccess(this.db, id, patch.access)
      // the members' connections follow the template's name and note (the slug, their tools and keys stay)
      if (!moved && (next.name !== t.name || next.notes !== t.notes)) {
        this.db.query('UPDATE integrations SET name=?, notes=?, version=version+1, updated_at=? WHERE template_id=?').run(next.name, next.notes, at, id)
      }
    })()
    const after = templateAccess(this.db, id)
    const accessChanged = JSON.stringify(before) !== JSON.stringify(after)
    if (changed.length || accessChanged) {
      audit(this.db, { actor: viewer.id, action: 'integration_template.update', target: id, detail: auditDetail(next, { changed: [...changed, ...(accessChanged ? ['access'] : [])], ...(accessChanged ? { access: { before, after } } : {}), ...(moved ? { keysDropped: true } : {}) }) })
    }
    if (moved) await this.svc.dropFromTemplate(madeFrom(this.db, id), viewer.id, 'template_moved')
    else if (accessChanged) await this.sweep(id)
    return this.adminView(getTemplate(this.db, id)!)
  }

  async remove(viewer: Viewer, id: string): Promise<void> {
    if (!isAdmin(viewer.role)) fail('forbidden')
    const t = getTemplate(this.db, id) ?? fail('not_found')
    const rows = madeFrom(this.db, id)
    this.db.query('DELETE FROM integration_templates WHERE id = ?').run(id)
    audit(this.db, { actor: viewer.id, action: 'integration_template.delete', target: id, detail: auditDetail(t, { connections: rows.length }) })
    await this.svc.dropFromTemplate(rows, viewer.id, 'template_deleted')
  }

  // ---------------- members ----------------
  /** the templates shared with this member, each with their connection made from it */
  async listMine(viewer: Viewer, L: Locale): Promise<MyIntegrationTemplate[]> {
    if (!activeUser(this.db, viewer.id)) return []
    await this.sweep()
    const rows = (this.db.query(`SELECT ${COLUMNS} FROM integration_templates ORDER BY name, id`).all() as TemplateRow[]).filter((t) => templateCovers(this.db, t.id, viewer.id))
    return rows.map((t) => {
      const mine = this.db.query(`${selectRows(this.db)} WHERE template_id = ? AND owner_user_id = ?`).get(t.id, viewer.id) as Row | null
      return {
        id: t.id, kind: t.kind, name: t.name, url: bareUrl(t.url), auth: t.auth, authHeader: t.auth_header, notes: t.notes,
        createdBy: this.person(t.created_by), connection: mine ? view(this.db, mine, viewer, L) : null,
      }
    })
  }

  /** The member connects a template shared with them: their own connection, made through service.ts create with the
   * template's address, sign-in method and header (so a key goes only there). Connected already: a key given replaces
   * theirs (service.ts update); a sign-in gives the same connection again (the app signs in next). */
  async connect(viewer: Viewer, id: string, answer: IntegrationTemplateAnswer, L: Locale): Promise<Integration> {
    const t = getTemplate(this.db, id)
    // not shared with this member (admins included) is the same as no such template
    if (!t || !activeUser(this.db, viewer.id) || !templateCovers(this.db, id, viewer.id)) return fail('not_found', say('templateNotForYou', L))
    if (t.auth !== 'oauth' && answer.secret === undefined) fieldError(L, 'secret', 'no_secret')
    if (t.auth === 'oauth' && answer.secret !== undefined) fieldError(L, 'secret', 'keyNeedsKeyAuth')
    const mine = this.db.query(`${selectRows(this.db)} WHERE template_id = ? AND owner_user_id = ?`).get(id, viewer.id) as Row | null
    if (mine) {
      const patch = { ...(answer.secret !== undefined ? { secret: answer.secret } : {}), ...(answer.writePolicy ? { writePolicy: answer.writePolicy } : {}) }
      return Object.keys(patch).length ? this.svc.update(viewer, mine.id, patch, L) : view(this.db, getRow(this.db, mine.id)!, viewer, L)
    }
    const made = await this.svc.create(viewer, {
      kind: t.kind, name: t.name, url: t.url, auth: t.auth, authHeader: t.auth_header, notes: t.notes, writePolicy: answer.writePolicy ?? 'ask',
      ...(answer.secret !== undefined ? { secret: answer.secret } : {}),
    }, 'personal', L, id)
    audit(this.db, { actor: viewer.id, action: 'integration_template.connect', target: id, detail: auditDetail(t, { connection: made.id }) })
    // the template changed or went while this ran: the connection does not stay with the old address or rule
    const now = getTemplate(this.db, id)
    if (!now || now.url !== t.url || now.auth !== t.auth || now.auth_header !== t.auth_header || !templateCovers(this.db, id, viewer.id)) {
      const row = getRow(this.db, made.id)
      if (row) await this.svc.dropFromTemplate([row], null, now ? 'template_moved' : 'template_deleted')
      return fail('conflict')
    }
    return made
  }
}

const instances = new WeakMap<AppContext, ConnectionTemplates>()
export function templatesOf(ctx: AppContext): ConnectionTemplates {
  let s = instances.get(ctx)
  if (!s) { s = new ConnectionTemplates(ctx); instances.set(ctx, s) }
  return s
}
