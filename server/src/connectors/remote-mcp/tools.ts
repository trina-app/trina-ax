import { z } from 'zod'
import { FILE_TOOLS, type FileToolName } from '@mycel/shared'
import type { AppContext } from '../../context'
import { TurnFiles } from '../../files/service'
import { authorize } from '../../policy/authorize'
import { listSkills, skillInfo } from '../../chat/skills'
import { sourceKey, sourceOf } from '../../chat/read-scope'
import { teamRuleFiles } from '../../chat/prompt'
import { audit } from '../../admin/audit'
import { ADMIN_SCOPE, hash, OAuthError, ROOMS_SCOPE, ROOMS_WRITE_SCOPE } from './policy'
import { dropAdminScope, isTeamAdmin, remoteOAuthOf, type Grant, type RemoteOAuth } from './oauth'
import { checkWriteTarget, isOutcome, uploadFile, uploadTool, writeNotes } from './upload'
import { openScope, saveScope, scopeFull, scopeSources, SCOPE_SOURCES_MAX } from './scope'
import { createUploadLink, uploadLinkTool } from './upload-link'
import { shareSkills, shareSkillsTool } from './share'
import { GROUP_TOOLS, groupTool, groupTools } from './groups'
import { mergeSources, ROOM_SEND, ROOM_TOOLS, roomReadTools, roomSendTool, roomTool } from './rooms'

const WRITE = new Set(['write', 'edit', 'upload_file', 'create_upload_link', 'share_skills'])
const CONNECTOR_ONLY = new Set(['upload_file', 'create_upload_link'])
const toolList = Object.entries(FILE_TOOLS).map(([name, t]) => {
  const schema = z.toJSONSchema(t.input as any, { target: 'draft-7' }) as Record<string, unknown>
  delete schema.$schema
  return { name, description: t.description, inputSchema: schema, annotations: { readOnlyHint: !WRITE.has(name), destructiveHint: WRITE.has(name), openWorldHint: false } }
})
const skillTool = { name: 'skills_list', description: 'Discover the team skills you can read, the skills of your groups (group: { id, name }; only that group\'s members see them) and your own personal skills (personal: true). One name: your personal skill replaces a group\'s or the team\'s, a group\'s replaces the team\'s. Entries with rule: true are team rules (skills/*.md without a skill header) that every teammate\'s AI follows: read them before working on team files. Use read on a returned path when needed. Skill metadata never grants tool permissions or executes scripts.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) })
type Memory = { files: TurnFiles; tail: Promise<void>; queued: number; touched: number }
/** A skills_list entry for a team rule (skills/*.md without a skill header): every teammate's AI follows it. */
const ruleInfo = (rel: string) => ({ path: rel, name: rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, ''), rule: true as const })

/**
 * Core file tools, plus the connector's own upload tools, with mcp:rooms the person's team chat rooms (rooms.ts; with
 * mcp:rooms.write also room_send) and, with mcp:admin for an owner or admin, the group tools (groups.ts, the server
 * functions of Admin › Groups). The local Unix turn registry, and the in-app AI's admin, Drive, browser and network
 * tools are never imported.
 */
export class RemoteTools {
  private memory = new Map<string, Memory>()
  constructor(readonly ctx: AppContext, readonly oauth: () => RemoteOAuth = () => remoteOAuthOf(ctx)) {}
  list(g: Grant) {
    const scopes = JSON.parse(g.scopes) as string[]
    // the group tools: the scope, and the person's role now (a demoted admin's grant does not list them)
    const admin = scopes.includes(ADMIN_SCOPE) && isTeamAdmin(this.ctx.db, g.user_id)
    const rooms = scopes.includes(ROOMS_SCOPE), roomsWrite = rooms && scopes.includes(ROOMS_WRITE_SCOPE)
    return [...[...toolList, uploadTool, uploadLinkTool].filter(t => !WRITE.has(t.name) || scopes.includes('mcp:write')), skillTool,
      ...(scopes.includes('mcp:write') ? [shareSkillsTool] : []), ...(rooms ? roomReadTools : []), ...(roomsWrite ? [roomSendTool] : []), ...(admin ? groupTools : [])]
  }
  private policy(user: string) {
    return hash(JSON.stringify({
      user: this.ctx.files.principal(user),
      rules: this.ctx.db.query('SELECT f.id,f.path,r.subject_type,r.subject_id,r.access FROM folder_rules r JOIN folders f ON f.id=r.folder_id ORDER BY f.id,r.subject_type,r.subject_id,r.access').all(),
    }))
  }
  /**
   * One tool call. `session`: the Mcp-Session-Id the client sent (transport.ts), or null: the read scope is the
   * session's (scope.ts), so a new session starts with nothing read. The queue and the TurnFiles (files read before an
   * edit, the write counters) stay the connection's: a client can send any id, and one per call must not give it more
   * calls at once, more memory slots or a fresh write budget.
   */
  async call(token: string, name: string, args: unknown, signal?: AbortSignal, session: string | null = null) {
    const oauth = this.oauth(), grant = oauth.authenticate(token)
    oauth.rate('tool-user', grant.user_id, 120)
    if (name !== 'skills_list' && name !== 'share_skills' && !CONNECTOR_ONLY.has(name) && !GROUP_TOOLS.has(name) && !ROOM_TOOLS.has(name) && !Object.hasOwn(FILE_TOOLS, name)) return result('Unknown tool.', true)
    // Bound idle memory; read sources survive eviction/restart in remote_mcp_scopes.
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
      if (!scopes.includes('mcp:read') || (WRITE.has(name) && !scopes.includes('mcp:write')) || (GROUP_TOOLS.has(name) && !scopes.includes(ADMIN_SCOPE))
        || (ROOM_TOOLS.has(name) && !scopes.includes(ROOMS_SCOPE)) || (name === ROOM_SEND && !scopes.includes(ROOMS_WRITE_SCOPE))) return result('This connection has no permission for that tool. Reconnect with the required scope.', true)
      const user = this.ctx.files.principal(fresh.user_id)
      // what this session read before (an idle scope without a session is forgotten here); any call keeps it in use
      const scope = openScope(this.ctx.db, fresh.id, session, oauth.now())
      if (ROOM_TOOLS.has(name)) {
        // the rooms as the person sees them, or a message as them (rooms.ts). No audit line and no count (the owner's
        // decision); what was read joins this session's read scope, as a file read does
        const r = await roomTool(this.ctx, user, name, args, m.files, scope, signal)
        oauth.authenticate(token)
        if (signal?.aborted) return result('Access changed during the call. Please retry.', true)
        if (r.seen.length) {
          const sources = mergeSources([...scope.sources, ...scopeSources(this.ctx.db, scope.grantId, scope.key, oauth.now())], r.seen)
          if (sources.length > SCOPE_SOURCES_MAX) return result(scopeFull(scope), true)
          saveScope(this.ctx.db, scope, sources, oauth.now())
        }
        // text only: a connection has no turn, so a picture comes as its note or its text (files/vision.ts)
        return result(r.content.map(c => c.type === 'text' ? c.text : '').filter(Boolean).join('\n'), !!r.isError)
      }
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
        // and the team rules the in-app AI follows (chat/prompt.ts teamRuleFiles: the first ten the person may read),
        // marked rule: true; the client reads them with read, so they join the read scope as any read does
        const skills = [...listSkills(this.ctx.files, user).map(skillInfo), ...teamRuleFiles(this.ctx.files, user).paths.map(ruleInfo)]
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
        const out = name === 'upload_file' ? await uploadFile(this.ctx, user, args, scope) : createUploadLink(this.ctx, oauth, fresh, user, args, scope)
        // The audit row holds actor, path and size, never the content.
        audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: fresh.id, detail: { tool: name, ok: !out.isError, via: 'connector', ...out.audit } })
        return result(out.text, out.isError)
      }
      const input = FILE_TOOLS[name as FileToolName].input.safeParse(args ?? {})
      if (!input.success) return result('Invalid tool input.', true)
      let notes: string[] = []
      if (WRITE.has(name)) {
        const filePath = (input.data as { file_path: string }).file_path
        // A null turn ID normally means a human file API. An external model has no server confirmation card: no team
        // skill or rule (skills/), no group's skill and no personal skill of the person (users/<id>/skills/) either.
        // The same check as upload_file, create_upload_link and the link's PUT (checkUploadTarget), the path as written
        // first: on a case-sensitive disk (Linux) "Users/<id>/Skills" is an unknown folder that authorize refuses with
        // a vaguer answer, so the same request would read differently by OS. A refusal answers as upload_file's does
        // (the reason, the rejected-file event, the audit row); only an unexpected error gets the generic answer
        const target = checkWriteTarget(this.ctx, user, filePath, scope, name)
        if (isOutcome(target)) {
          audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: fresh.id, detail: { tool: name, ok: false, via: 'connector', ...target.audit } })
          return result(target.text, true)
        }
        // edit changes an existing file: never the placement note
        notes = writeNotes(this.ctx, user, filePath, target, name === 'write' && !target.exists)
      }
      m.files.readPaths.clear()
      const out = await this.ctx.files.call(name, input.data, { user, turnId: null, files: m.files, signal })
      // File extraction/search may await. Never release a stale result after access, scope or session changes.
      const latest = oauth.authenticate(token)
      if (signal?.aborted || this.policy(user.id) !== policy) return result('Access changed during the call. Please retry.', true)
      if (m.files.readHashes.size > 2000 || m.files.readPaths.size > 2000) { m.files.readHashes.clear(); return result('Read limit reached; narrow the search.', true) }
      if (m.files.readPaths.size) {
        const rules = this.ctx.files.rules()
        const sources = new Map([...scope.sources, ...scopeSources(this.ctx.db, scope.grantId, scope.key, oauth.now())].map(s => [sourceKey(s), s]))
        for (const path of m.files.readPaths) {
          const allowed = authorize(this.ctx.files.fx, rules, user, path, 'read')
          const source = sourceOf(this.ctx.db, rules, allowed.rel); sources.set(sourceKey(source), source)
        }
        if (sources.size > SCOPE_SOURCES_MAX) return result(scopeFull(scope), true)
        saveScope(this.ctx.db, scope, [...sources.values()], oauth.now())
      }
      audit(this.ctx.db, { actor: user.id, action: 'remote_mcp.tool', target: latest.id, detail: { tool: name, ok: !out.isError } })
      return result(notes.length && !out.isError ? `${out.text}\n\n${notes.join(' ')}` : out.text, out.isError)
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
