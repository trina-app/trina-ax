import { z } from 'zod'
import { FILE_TOOLS, type FileToolName } from '@mycel/shared'
import type { AppContext } from '../../context'
import { TurnFiles } from '../../files/service'
import { authorize } from '../../policy/authorize'
import { listSkills, skillInfo } from '../../chat/skills'
import { sourceKey, sourceOf, widening, type ReadSource } from '../../chat/read-scope'
import { audit } from '../../admin/audit'
import { ADMIN_SCOPE, hash, OAuthError } from './policy'
import { dropAdminScope, isTeamAdmin, remoteOAuthOf, type Grant, type RemoteOAuth } from './oauth'
import { skillWriteTarget, uploadFile, uploadTool } from './upload'
import { createUploadLink, uploadLinkTool } from './upload-link'
import { shareSkills, shareSkillsTool } from './share'
import { GROUP_TOOLS, groupTool, groupTools } from './groups'

const WRITE = new Set(['write', 'edit', 'upload_file', 'create_upload_link', 'share_skills'])
const CONNECTOR_ONLY = new Set(['upload_file', 'create_upload_link'])
const toolList = Object.entries(FILE_TOOLS).map(([name, t]) => {
  const schema = z.toJSONSchema(t.input as any, { target: 'draft-7' }) as Record<string, unknown>
  delete schema.$schema
  return { name, description: t.description, inputSchema: schema, annotations: { readOnlyHint: !WRITE.has(name), destructiveHint: WRITE.has(name), openWorldHint: false } }
})
const skillTool = { name: 'skills_list', description: 'Discover the team skills you can read, the skills of your groups (group: { id, name }; only that group\'s members see them) and your own personal skills (personal: true). One name: your personal skill replaces a group\'s or the team\'s, a group\'s replaces the team\'s. Use read on a returned path when needed. Skill metadata never grants tool permissions or executes scripts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) })
type Memory = { files: TurnFiles; tail: Promise<void>; queued: number; touched: number }

/**
 * Core file tools, plus the connector's own upload tools and, with mcp:admin for an owner or admin, the group tools
 * (groups.ts, the server functions of Admin › Groups). The local Unix turn registry, and the in-app AI's admin, Drive,
 * browser and network tools are never imported.
 */
export class RemoteTools {
  private memory = new Map<string, Memory>()
  constructor(readonly ctx: AppContext, readonly oauth: () => RemoteOAuth = () => remoteOAuthOf(ctx)) {}
  list(g: Grant) {
    const scopes = JSON.parse(g.scopes) as string[]
    // the group tools: the scope, and the person's role now (a demoted admin's grant does not list them)
    const admin = scopes.includes(ADMIN_SCOPE) && isTeamAdmin(this.ctx.db, g.user_id)
    return [...[...toolList, uploadTool, uploadLinkTool].filter(t => !WRITE.has(t.name) || scopes.includes('mcp:write')), skillTool,
      ...(scopes.includes('mcp:write') ? [shareSkillsTool] : []), ...(admin ? groupTools : [])]
  }
  private policy(user: string) {
    return hash(JSON.stringify({
      user: this.ctx.files.principal(user),
      rules: this.ctx.db.query('SELECT f.id,f.path,r.subject_type,r.subject_id,r.access FROM folder_rules r JOIN folders f ON f.id=r.folder_id ORDER BY f.id,r.subject_type,r.subject_id,r.access').all(),
    }))
  }
  async call(token: string, name: string, args: unknown, signal?: AbortSignal) {
    const oauth = this.oauth(), grant = oauth.authenticate(token)
    oauth.rate('tool-user', grant.user_id, 120)
    if (name !== 'skills_list' && name !== 'share_skills' && !CONNECTOR_ONLY.has(name) && !GROUP_TOOLS.has(name) && !Object.hasOwn(FILE_TOOLS, name)) return result('Unknown tool.', true)
    // Bound idle memory; read sources survive eviction/restart in the grant row.
    for (const [id, m] of this.memory) if (!m.queued && m.touched < oauth.now() - 10 * 60_000) this.memory.delete(id)
    let m = this.memory.get(grant.id)
    if (!m) {
      if (this.memory.size >= 128) {
        const idle = [...this.memory].find(([, item]) => item.queued === 0)
        if (idle) this.memory.delete(idle[0]); else return result('Server busy; retry later.', true)
      }
      m = { files: new TurnFiles(), tail: Promise.resolve(), queued: 0, touched: oauth.now() }; this.memory.set(grant.id, m)
    }
    if (m.queued >= 4) return result('Connector busy; retry after the current call.', true)
    const before = m.tail
    let release!: () => void
    m.tail = new Promise<void>(resolve => { release = resolve }); m.queued++
    try {
      await before
      if (signal?.aborted) throw new OAuthError('invalid_request', 400)
      const fresh = oauth.authenticate(token), scopes = JSON.parse(fresh.scopes) as string[]
      if (!scopes.includes('mcp:read') || (WRITE.has(name) && !scopes.includes('mcp:write')) || (GROUP_TOOLS.has(name) && !scopes.includes(ADMIN_SCOPE))) return result('This connection has no permission for that tool. Reconnect with the required scope.', true)
      const user = this.ctx.files.principal(fresh.user_id)
      if (GROUP_TOOLS.has(name)) {
        // The role now, not at consent: a person who is no longer an owner or admin loses mcp:admin on this grant for
        // good. Nothing awaits between this check and the change (groups.ts is synchronous).
        if (user.role !== 'owner' && user.role !== 'admin') {
          dropAdminScope(this.ctx.db, user.id, 'role')
          audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: fresh.id, detail: { tool: name, ok: false, via: 'connector', reason: 'not_admin' } })
          return result('Only an owner or admin can manage groups. This connection can no longer use the group tools.', true)
        }
        const out = groupTool(this.ctx, oauth, user, name, args)
        audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: fresh.id, detail: { tool: name, ok: !out.isError, via: 'connector', ...out.audit } })
        return result(out.text, out.isError)
      }
      const policy = this.policy(user.id)
      if (name === 'skills_list') {
        if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) return result('Invalid input.', true)
        const skills = listSkills(this.ctx.files, user).map(skillInfo)
        return result(JSON.stringify(skills))
      }
      if (name === 'share_skills') {
        // a proposal only: nothing reaches the team before the person confirms it in the app (skills/share.ts)
        const out = shareSkills(this.ctx, oauth, user, args)
        // counts and the proposal's id, never a skill's name or content
        audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: fresh.id, detail: { tool: name, ok: !out.isError, via: 'connector', ...out.audit } })
        return result(out.text, out.isError)
      }
      if (CONNECTOR_ONLY.has(name)) {
        // Same scope, write rule, skills and widening checks as write. No await before the bytes are placed.
        const out = name === 'upload_file' ? await uploadFile(this.ctx, user, args, JSON.parse(fresh.sources) as ReadSource[]) : createUploadLink(this.ctx, oauth, fresh, user, args)
        // The audit row holds actor, path and size, never the content.
        audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: fresh.id, detail: { tool: name, ok: !out.isError, via: 'connector', ...out.audit } })
        return result(out.text, out.isError)
      }
      const input = FILE_TOOLS[name as FileToolName].input.safeParse(args ?? {})
      if (!input.success) return result('Invalid tool input.', true)
      if (WRITE.has(name)) {
        const filePath = (input.data as { file_path: string }).file_path
        // A null turn ID normally means a human file API. An external model has no server confirmation card: no team
        // skill or rule (skills/), and no personal skill of the person (users/<id>/skills/) either. The path as written
        // is checked first: on a case-sensitive disk (Linux) "Users/<id>/Skills" is an unknown folder that authorize
        // refuses with a vaguer answer, so the same request would read differently by OS
        if (skillWriteTarget(filePath)) return result('Skill changes require confirmation inside the team app.', true)
        const target = authorize(this.ctx.files.fx, this.ctx.files.rules(), user, filePath, 'write', { createDirs: true })
        if (skillWriteTarget(target.rel)) return result('Skill changes require confirmation inside the team app.', true)
        const sources = JSON.parse(fresh.sources) as ReadSource[]
        if (widening(this.ctx.db, null, target.segs, sources)) return result('Saving here would expose previously read material to more people. Use a folder with the same or narrower access.', true)
      }
      m.files.readPaths.clear()
      const out = await this.ctx.files.call(name, input.data, { user, turnId: null, files: m.files, signal })
      // File extraction/search may await. Never release a stale result after access, scope or session changes.
      const latest = oauth.authenticate(token)
      if (signal?.aborted || this.policy(user.id) !== policy) return result('Access changed during the call. Please retry.', true)
      if (m.files.readHashes.size > 2000 || m.files.readPaths.size > 2000) { m.files.readHashes.clear(); return result('Read limit reached; narrow the search.', true) }
      const rules = this.ctx.files.rules(), sources = new Map((JSON.parse(latest.sources) as ReadSource[]).map(s => [sourceKey(s), s]))
      for (const path of m.files.readPaths) {
        const allowed = authorize(this.ctx.files.fx, rules, user, path, 'read')
        const source = sourceOf(this.ctx.db, rules, allowed.rel); sources.set(sourceKey(source), source)
      }
      if (sources.size > 2000) return result('Read scope limit reached; reconnect to continue.', true)
      this.ctx.db.query('UPDATE remote_mcp_grants SET sources=? WHERE id=?').run(JSON.stringify([...sources.values()]), latest.id)
      audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: latest.id, detail: { tool: name, ok: !out.isError } })
      return result(out.text, out.isError)
    } catch (e) {
      if (e instanceof OAuthError) throw e
      // Do not include arbitrary exceptions, paths, tokens or file text in the connector audit/error.
      return result('Tool unavailable or access denied.', true)
    } finally { m.queued--; m.touched = oauth.now(); release() }
  }
}

const instances = new WeakMap<AppContext, RemoteTools>()
export function remoteToolsOf(ctx: AppContext) {
  if (!instances.has(ctx)) instances.set(ctx, new RemoteTools(ctx))
  return instances.get(ctx)!
}
