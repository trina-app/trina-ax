// share_skills (docs/DECISIONS.md "SK — 내 스킬 가져오기", "W5"; docs/INTEGRATIONS.md): Claude Code or Codex, connected
// to the team as the person who signed in, sends that person's own skills as a share proposal (Codex says so with
// `app: "codex"`: the proposal's source and app are then codex). Scope mcp:write, connector only.
// Nothing reaches the team here: the proposal waits, checked and judged by the server (skills/share.ts), until the
// person confirms it in the app. Owners and admins only; a member's way stays "스킬로 제안" in the app. The tool's
// description is what makes Claude Code look in the right places, leave out anything with a key, and send script files
// as their names only.
import { z } from 'zod'
import { CreateSkillShare, ShareSkillIn, SKILL_SHARE_LIMITS, type Locale } from '@mycel/shared/api'
import { Locale as LocaleSchema } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import type { Principal } from '../../policy/access'
import { teamDefaultLocale } from '../../admin/settings'
import { getChatRuntime, type ChatRuntime } from '../../chat/runtime'
import { HttpError } from '../../http/errors'
import { createSkillShare } from '../../skills/share'
import { writableGroupSkillRoots } from '../../chat/skills'
import { OAuthError } from './policy'
import type { RemoteOAuth } from './oauth'

/** What Claude Code or Codex sends: a share without its source (claude_code, or codex with app "codex"), at most
 * connectorSkills skills. */
export const ShareSkillsInput = CreateSkillShare.omit({ source: true }).extend({
  app: z.enum(['claude', 'codex']).optional().describe('Which app is calling: "codex" when you are Codex; omit or "claude" for Claude Code.'),
  skills: z.array(ShareSkillIn).max(SKILL_SHARE_LIMITS.connectorSkills).describe('The skills to propose, each with its files.'),
  group: z.string().min(1).max(100).nullable().optional().describe('Only when the user wants these skills for one of their groups, not the whole team: that group\'s name (as skills_list shows it under "group") or id. Omit for the whole team.'),
}).strict()
export type ShareSkillsInput = z.infer<typeof ShareSkillsInput>

/** share proposals one person may send per minute */
const PER_MINUTE = 5
const kb = (n: number) => Math.round(n / 1024)

const schema = z.toJSONSchema(ShareSkillsInput, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
delete schema.$schema
export const shareSkillsTool = {
  name: 'share_skills',
  description: [
    'Propose the user\'s own Claude Code or Codex skills to their team in the team app. Only the team\'s owner or an admin can share; a member suggests a skill in the app instead (팀 스킬 › 스킬로 제안). Nothing changes in the team until the team lead confirms the proposal in the app, and the server checks every skill again.',
    'To propose them to one of the user\'s groups only (its members alone see and use them, and they review it), set "group" to that group\'s name; omit it for the whole team. The user can still change where it goes in the app.',
    'Before calling: (1) call skills_list to see the team\'s skills. (2) Claude Code: look for skills in ~/.claude/skills/<name>/ (origin "user"), in the .claude/skills/<name>/ folders of the projects you know (origin "project", with "project" set to the project folder\'s own name only, never a full path), and ~/.claude/commands/*.md (origin "command": the one .md file); plugin skills (under ~/.claude/plugins) are never sent: list them under "excluded" with reason "plugin". Read ~/.claude/CLAUDE.md and the CLAUDE.md of the projects you know. Codex: set "app": "codex"; look in ~/.agents/skills/<name>/ and ~/.codex/skills/<name>/ (origin "user"; never ~/.codex/skills/.system, Codex\'s own), the .agents/skills/ and .codex/skills/ folders of the projects you know (origin "project"), and ~/.codex/prompts/*.md if there are any (origin "command"). Read ~/.codex/AGENTS.md (AGENTS.override.md when it is there) and the AGENTS.md of the projects you know. (3) Send the rule files\' text joined as rule.text: the server keeps only the lines that fit the whole team as one team rule.',
    'Never send a file that contains an API key, a token, a password or a private key, nor a .env, *.pem, *.key, id_rsa, id_ed25519, .npmrc, .netrc or credentials file: list that skill under "excluded" with reason "secret" (and "kind", such as "slack" or "openai") and send none of its files.',
    `Each skill: "name" is its folder name (a command: its file name without .md); "files" have paths relative to the skill folder ("SKILL.md", "templates/quote.md"). Text files (md, txt, json, yaml, csv, tsv, html, xml, svg) go as "text", at most ${kb(SKILL_SHARE_LIMITS.fileBytes)} KB each; small images (png, jpg, gif, webp, at most ${kb(SKILL_SHARE_LIMITS.fileBytes)} KB) as "base64"; script and code files (py, sh, js, ts and so on) go as their path with "text": "" (never their content: the team never runs a skill's scripts); leave every other file out. At most ${SKILL_SHARE_LIMITS.skillFiles} files and ${kb(SKILL_SHARE_LIMITS.skillBytes)} KB per skill and ${SKILL_SHARE_LIMITS.connectorSkills} skills per call (keep one call under about 20 MB); list a bigger skill under "excluded" with reason "too_big".`,
    '"tools": only remote MCP servers reached over https (Streamable HTTP), as { name, url, auth: "bearer" | "header" | "oauth", header (the header\'s name, for "header") }. Codex: the [mcp_servers.<name>] entries of ~/.codex/config.toml that have a url (bearer_token_env_var → "bearer"; http_headers or env_http_headers → "header" with the header\'s name; else "oauth"). There is no field for a key, a token, an environment variable or a header value and none may be in the url: each teammate connects with their own. Local (stdio, "command") MCP servers cannot be shared: leave them out.',
    '"picked": the names you would recommend for the whole team (the server judges again); "projects": how many project folders you looked in.',
    'The answer has the proposal\'s link: give it to the user. Nothing changes until the team lead confirms in the app.',
  ].join('\n\n'),
  inputSchema: schema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}

export type ShareOutcome = { text: string; isError?: boolean; audit: Record<string, unknown> }
const refuse = (text: string, audit: Record<string, unknown> = {}): ShareOutcome => ({ text, isError: true, audit })

function localeOf(ctx: AppContext, id: string): Locale {
  const v = LocaleSchema.safeParse((ctx.db.query('SELECT locale FROM users WHERE id = ?').get(id) as { locale: string } | null)?.locale)
  return v.success ? v.data : teamDefaultLocale(ctx.db)
}

/** The schema's complaints by place, never the values sent (they may hold anything). */
function problems(e: z.ZodError): string {
  return e.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')
}

/** share_skills: the scope check ran in RemoteTools.call. */
export function shareSkills(ctx: AppContext, oauth: RemoteOAuth, user: Principal, args: unknown, runtime: () => ChatRuntime | null = () => { try { return getChatRuntime(ctx) } catch { return null } }): ShareOutcome {
  if (user.role !== 'owner' && user.role !== 'admin') {
    return refuse('Only the team\'s owner or an admin can share skills with the team. A member suggests a skill in the team app instead: 팀 스킬 › 스킬로 제안 (Team skills › Suggest as a skill). Nothing was sent.', { refused: 'member' })
  }
  const input = ShareSkillsInput.safeParse(args ?? {})
  if (!input.success) return refuse(`Invalid input: ${problems(input.error)}. Nothing was sent; fix these and call share_skills again (a skill that does not fit goes under "excluded").`, { refused: 'input' })
  // proposals made, per person (a wrong input costs nothing but the connector's own call limit)
  try { oauth.rate('share-skills-user', user.id, PER_MINUTE) } catch (e) {
    if (e instanceof OAuthError) return refuse('Too many share proposals; retry in a minute.', { refused: 'rate' })
    throw e
  }
  // a group of the user's whose skills folder they may write, by its id or its name (letter case ignored)
  let group: string | null = null
  if (input.data.group) {
    const fold = (s: string) => s.normalize('NFC').trim().toLowerCase()
    const mine = writableGroupSkillRoots(ctx.files, user)
    const hit = mine.find((g) => g.id === input.data.group) ?? mine.find((g) => fold(g.name) === fold(input.data.group!))
    if (!hit) {
      return refuse(`Not sent: "${input.data.group.slice(0, 100)}" is not a group of the user's whose skills they may add. ${mine.length ? `Their groups: ${mine.map((g) => JSON.stringify(g.name)).join(', ')}.` : 'They are in no such group: omit "group" for the whole team.'}`, { refused: 'group' })
    }
    group = hit.id
  }
  let share
  try {
    const { app, group: _named, ...rest } = input.data
    share = createSkillShare(ctx, runtime(), { id: user.id, role: user.role }, localeOf(ctx, user.id), { ...rest, group, source: app === 'codex' ? 'codex' : 'claude_code', app: app === 'codex' ? 'codex' : 'claude' }, { via: 'connector' })
  } catch (e) {
    if (e instanceof HttpError) return refuse(`Not sent: ${e.userMessage ?? e.code}.`, { refused: e.code })
    throw e
  }
  const url = `${oauth.enabled()}/skills/share/${share.id}`
  const out = { proposalId: share.id, url, status: 'pending' as const }
  const excluded = share.candidates.filter((c) => c.group === 'excluded').length
  return {
    text: `${JSON.stringify(out)}\n\nNothing changes until the team lead confirms in the app.`,
    audit: { proposalId: share.id, app: share.app, skills: share.candidates.length - excluded, excluded, rule: !!input.data.rule, tools: share.tools.length, ...(group ? { group } : {}) },
  }
}
