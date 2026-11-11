// Server configuration: ONE JSON file + environment overrides (tab 6: config/server.json holds port, team folder,
// connection mode, update channel; team settings live in the DB `settings` table).
//
// Where the file is:   --config <path>  >  $MYCEL_CONFIG  >  dev: <repo>/.dev/server.json (optional)
//                                                           prod: /Library/Application Support/mycel/config/server.json
//                                                                 (Linux: /var/lib/mycel/config/server.json)
// Env overrides (win over the file): MYCEL_MODE, MYCEL_HOST, MYCEL_PORT, MYCEL_TEAM_ROOT, MYCEL_DATA_DIR,
// MYCEL_LOG_DIR, MYCEL_LOG_LEVEL, MYCEL_PUBLIC_ORIGINS (comma separated), MYCEL_SETUP_TOKEN,
// MYCEL_RELAY_URL (ws(s)://<relay>/connect, '' = off), MYCEL_RELAY_TEAM (team name at the relay), MYCEL_RELAY_OFFICIAL
// (1 = the official relay may be offered), MYCEL_DEPLOYMENT (self | hosted, server/src/system/deployment.ts),
// MYCEL_DEMO (a demo file, `bun run demo:company`: development servers only, refused anywhere else; readDemoFile),
// MYCEL_PUSH_GATEWAY (the native app push gateway, https://<host> or http://127.0.0.1:<port>; unset or '' = off).
// Office mode (one Mac in a small office, docs/OFFICE.md) is dev mode's engine setup (local-login, engine.sb,
// lockdown) with `office: true`: no DEV banner, and its supervisor (server/src/office/cli.ts) writes the file (TLS
// listener on the office network, allowedHosts, publicOrigins).
// Relative paths in the file are resolved against the file's folder.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { AuthMode, PRODUCT, SourceCodeConfig } from '@mycel/shared'
import { CredentialKind } from '@mycel/shared/api'
import { CLOUD_DEFAULT_CREDENTIAL_KINDS } from '@mycel/shared/cloud-protocol'
import { DemoFile } from '@mycel/shared/api'

export const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
export const DEV_DIR = path.join(REPO_ROOT, '.dev')
/** The installed server's base folder: macOS /Library/Application Support/<id>, Linux /var/lib/<id>
 * (docs/INSTALL-LINUX.md; the Linux installer writes every path into server.json anyway, this is the fallback). */
export const prodBase = (platform: NodeJS.Platform = process.platform) =>
  platform === 'linux' ? `/var/lib/${PRODUCT.id}` : `/Library/Application Support/${PRODUCT.id}`
export const PROD_BASE = prodBase()
/** default log folder of an installed server: Linux logs to journald only (stdout), macOS to /Library/Logs/<id> */
export const prodLogDir = (platform: NodeJS.Platform = process.platform): string | null => platform === 'linux' ? null : `/Library/Logs/${PRODUCT.id}`
/** Foundation dev server port (component port ranges: docs/WORKPLAN.md). */
export const DEV_PORT = 19100
/** model proxy port when server.json names none (the installer's default --proxy-port) */
export const DEFAULT_PROXY_PORT = 47821
export const ANTHROPIC_API = 'https://api.anthropic.com'
/** where the model proxy sends each family's requests (engine.modelUpstreams overrides them for tests) */
export const DEFAULT_UPSTREAMS = {
  anthropic: ANTHROPIC_API,
  openai: 'https://api.openai.com/v1',
  chatgpt: 'https://chatgpt.com/backend-api/codex',
  openaiAuth: 'https://auth.openai.com',
} as const
export type ModelUpstreams = { [K in keyof typeof DEFAULT_UPSTREAMS]: string }
/** every AI connection kind; engine.credentialKinds narrows it per deployment (docs/DECISIONS.md "AI 연결" D22) */
export const ALL_CREDENTIAL_KINDS: CredentialKind[] = [...CredentialKind.options]

/** 'subscription' and 'proxy' are older names of 'managed' (credentials D18): a server.json written by either the
 * previous or the next installer starts this server, and this server's file starts the previous one. */
export function normalizeAuthMode(v: AuthMode | string | undefined): 'local-login' | 'managed' {
  return v === undefined || v === 'local-login' ? 'local-login' : 'managed'
}

/** An address the real credential may be sent to: https, or plain http to this machine only (a fake upstream in
 * tests); never with user:password in it. */
const credentialUrl = (u: string) => {
  try {
    const x = new URL(u)
    if (x.username || x.password) return false
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname))
  } catch { return false }
}
const UpstreamUrl = z.string().url().refine(credentialUrl, 'model upstreams must be https:// (http:// only for 127.0.0.1 / localhost)')
/** A model id of an Anthropic-compatible gateway: the argv-safe shape of chat/engines.ts MODEL_RE (it goes to
 * `--model` and the engine's environment, never read as an option), and never `claude-*`: that is Anthropic's own
 * name, which a gateway forwards to Anthropic at Anthropic's price (the gateway's own id, e.g. anthropic/claude-…, is fine). */
const GatewayModel = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/, 'gateway model ids: letters, digits and . _ - : / [ ] (at most 100)')
  .refine((m) => !/^claude-/i.test(m), 'a claude-* id would be billed by Anthropic through the gateway; use the gateway\'s own id for that model')
/** USD per million tokens; cache reads and writes cost the input price unless given */
const GatewayPrice = z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative().optional(), cacheWrite: z.number().nonnegative().optional() })
export type GatewayPrice = z.infer<typeof GatewayPrice>
/** engine.anthropicGateway (docs/DECISIONS.md "Anthropic-compatible gateway"): Claude Code's requests go to an
 * Anthropic Messages-compatible address (OpenRouter, DeepSeek, Kimi, GLM ...) instead of Anthropic, on these models only */
export const AnthropicGatewayConf = z.object({
  /** without /v1: the proxy adds /v1/messages, as Claude Code's ANTHROPIC_BASE_URL does */
  baseUrl: z.string().url()
    .refine(credentialUrl, 'anthropicGateway.baseUrl must be https:// (http:// only for 127.0.0.1 / localhost)')
    .refine((u) => { try { const x = new URL(u); return !x.search && !x.hash && !/\/v1\/*$/.test(x.pathname) } catch { return false } }, 'anthropicGateway.baseUrl: no /v1 at the end (the proxy adds /v1/messages), no query'),
  /** shown in Admin > AI connections (default: the address's host) */
  label: z.string().trim().min(1).max(40).optional(),
  /** default: what a turn nobody chose a model for runs on; opus / sonnet / haiku: what Claude Code's aliases and its
   * small fast model become (missing ones are the default) */
  models: z.object({ default: GatewayModel, opus: GatewayModel.optional(), sonnet: GatewayModel.optional(), haiku: GatewayModel.optional() }),
  prices: z.record(GatewayModel, GatewayPrice).optional(),
})
export type AnthropicGatewayConf = z.infer<typeof AnthropicGatewayConf>
/** same port under its production name (installer --proxy-port; pf and the engine sandbox allow the engine account only this) */
export const PROD_PROXY_PORT = DEFAULT_PROXY_PORT

/** a public DNS name with at least one dot (app.example.com): lower case letters, digits, hyphens; no IP address */
export const PUBLIC_HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

export const AppConfigFile = z.object({
  mode: z.enum(['dev', 'prod']).optional(),
  listen: z.object({
    /** 127.0.0.1 in dev; prod HTTP is only reachable through the relay client (in-process app.fetch) and the TLS port */
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(DEV_PORT),
  }).default({ host: '127.0.0.1', port: DEV_PORT }),
  /** office-network direct connection (TLS, tab 4: 8443); null = off. host: '0.0.0.0' (IPv4) or '::' (IPv4 + IPv6).
   * managed: the server keeps the self-signed certificate naming every LAN address of this Mac (system/lan-cert.ts;
   * the production installer sets it). Office mode leaves it off: its supervisor keeps a CA-signed one. */
  tls: z.object({ host: z.string().default('0.0.0.0'), port: z.number().int().default(8443), certFile: z.string(), keyFile: z.string(), managed: z.boolean().default(false) }).nullable().default(null),
  /** Host headers (host:port, lower case) the direct listeners answer; anything else gets 421. Empty = any (dev, the
   * relay sets its own). Office mode lists the certificate's names and addresses: a DNS-rebinding page never gets in. */
  allowedHosts: z.array(z.string()).default([]),
  /** IPv4 CIDRs whose socket peers the direct listeners answer (loopback always); anything else gets 403. Empty = any.
   * Office mode lists the Mac's office subnets so a VPN peer (Tailscale) cannot reach the office port. */
  allowedPeers: z.array(z.string()).default([]),
  /** office mode (single Mac in a small office, docs/OFFICE.md): mode stays 'dev' for the engine (local-login) */
  office: z.boolean().default(false),
  /** public address through a Cloudflare Tunnel (office mode, docs/OFFICE.md "인터넷 주소"): cloudflared on this Mac
   * delivers https://<host> to the loopback app port (listen). Such requests (app port, loopback peer, Host = host)
   * are handled as https://<host> (Secure __Host- cookie, CSRF origin), their client IP is CF-Connecting-IP, and the
   * first-run setup is refused on them. allowFrom (IPv4 CIDRs) / countries (CF-IPCountry, e.g. KR) narrow who may use
   * the address; empty = anyone. null = no public address. */
  tunnel: z.object({
    host: z.string().regex(PUBLIC_HOST_RE, 'tunnel.host must be a lower-case DNS name such as app.example.com'),
    allowFrom: z.array(z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/, 'tunnel.allowFrom: IPv4 CIDRs (a.b.c.d/n)')).default([]),
    countries: z.array(z.string().regex(/^[A-Z]{2}$/, 'tunnel.countries: two-letter country codes such as KR')).default([]),
  }).nullable().default(null),
  /** extra allowed Origins for CSRF / WebSocket checks, e.g. https://acme.treesoop.com. Same host is always allowed. */
  publicOrigins: z.array(z.string()).default([]),
  /** app connectors (docs/INTEGRATIONS.md): people connect their own Claude to this server as a remote MCP server at
   * https://<tunnel.host>. Needs tunnel. Off by default: it opens /oauth, /mcp and /connector-uploads on the public
   * address. The environment variable MYCEL_REMOTE_MCP_ORIGIN, when set, wins (remote-mcp/oauth.ts connectorOrigin). */
  appConnectors: z.boolean().default(false),
  teamRoot: z.string().optional(),
  dataDir: z.string().optional(),
  logDir: z.string().nullable().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  engine: z.object({
    /** local-login: owner's own CLI login, engine runs as the current user (dev, office). managed: the team's AI
     * connections (Admin > AI connections) behind the model proxy (production, cloud, Linux). 'subscription' and
     * 'proxy' (older installers) are read as managed. */
    authMode: AuthMode.default('local-login'),
    /** AI connection kinds this deployment allows (docs/DECISIONS.md "AI 연결" D22). Default: all four. A kind left out
     * cannot be added, and existing connections of it are skipped (shown as "off on this server", never deleted).
     * The hosted cloud's enrollment writes all four (CLOUD_DEFAULT_CREDENTIAL_KINDS); the control plane may narrow it. */
    credentialKinds: z.array(CredentialKind).min(1).optional(),
    /** where the model proxy sends each family (tests: fake upstreams). Same rule as modelUpstream. `openrouter`: where
     * the hosting service's trial credit answers go (OPENROUTER_API; tests only, credentials/hosted-chat.ts) */
    modelUpstreams: z.object({ anthropic: UpstreamUrl.optional(), openai: UpstreamUrl.optional(), chatgpt: UpstreamUrl.optional(), openaiAuth: UpstreamUrl.optional(), openrouter: UpstreamUrl.optional() }).optional(),
    /** Claude Code on another company's models (AnthropicGatewayConf); managed mode only, never with
     * modelUpstreams.anthropic / modelUpstream. Claude subscription connections are off while it is set. */
    anthropicGateway: AnthropicGatewayConf.optional(),
    /** the model proxy's port on 127.0.0.1 (the installer's --proxy-port), the engine account's only network path:
     * Claude requests and Codex tunnels. pf and the launcher's sandbox allow the engine account only this port, so
     * another value here only makes the engine fail closed. */
    proxyPort: z.number().int().min(1).max(65535).optional(),
    /** where the model proxy sends requests (tests point it at a fake upstream). The owner's token goes there, so
     * HTTPS only; plain HTTP only to this Mac (a fake upstream in tests); no user:password in the address. */
    modelUpstream: z.string().url().refine(credentialUrl, 'modelUpstream must be https:// (http:// only for 127.0.0.1 / localhost)').optional(),
    claudeBin: z.string().optional(),
    codexBin: z.string().optional(),
    /** installed layout (tab 6, written by scripts/install-macos.sh): sockets <runDir>/tools.sock + private/, per-chat
     * engine folders, the LaunchDaemon launcher socket and the engine account uid. Dev: derived from dataDir. */
    runDir: z.string().optional(),
    agentRoot: z.string().optional(),
    launcherSock: z.string().optional(),
    agentUid: z.number().int().nonnegative().optional(),
  }).default({ authMode: 'local-login' }),
  relay: z.object({
    /** wss://relay.example/connect; null = no relay */
    url: z.string().nullable().default(null),
    teamName: z.string().nullable().default(null),
    /** the official relay (wss://relay.treesoop.com/connect) may be offered in Admin > System. On by default from the
     * release with the official relay add-on (control-plane SV-9: registration there needs a claim code from the
     * account console); a server.json can still turn it off. */
    officialAvailable: z.boolean().default(true),
  }).default({ url: null, teamName: null, officialAvailable: true }),
  update: z.object({
    channel: z.enum(['stable', 'beta']).default('stable'),
    feedUrl: z.string().nullable().default(null),
    /** apply app-only releases from the feed by itself, inside the team's update window (Linux self-host; the Mac
     * installer never sets it, the hosted cloud leaves it off: the control plane updates) */
    auto: z.boolean().default(false),
  }).default({ channel: 'stable', feedUrl: null, auto: false }),
  /** Operator-owned corresponding-source metadata. Does not publish or export source. */
  sourceCode: SourceCodeConfig.optional(),
  /** native app push (server/src/notifications/push-native.ts): the push gateway, https://<host>. Absent or null = off:
   * phone tokens go nowhere until the operator chooses a gateway (a hosted service writes it here). */
  push: z.object({ gatewayUrl: z.string().max(300).nullable().optional() }).strict().optional(),
  /** check every JSON response against the contract (default: on in dev) */
  validateResponses: z.boolean().optional(),
  /** how this server is installed (linux-runtime D24, server/src/system/deployment.ts): "self" (a customer's own server,
   * the default) or "hosted" (the hosted service: the operator owns server.json, the team's server account only reads
   * it; the control plane writes it at enrolment). Office mode and dev stay what `office` / `mode` say. */
  deployment: z.enum(['self', 'hosted']).optional(),
  /** 팀장 넘기기 on the hosted service (server/src/admin/handover.ts, docs/DECISIONS.md "W6"): the hosting operator sets it
   * once its control plane refuses owner and admin reset links after a transfer (both forms of `reset-link`) until the
   * new owner claims recovery. Until then a hosted team gets no lead flag and no card, and both people are told who can
   * still reset passwords. With it on, a transfer sets the recovery lock that `mycel-ctl reset-link` keeps until
   * `admin.js owner-recovery-claimed` clears it (the tenant command `owner-recovery-claimed`, shared/src/cloud-protocol and
   * mycel-ctl). Do not turn it on before the control plane runs that command after the new owner's claim: until then a
   * lock could not be cleared, and nobody could reset an owner or admin password of that team from outside. Ignored on a self-installed server, office mode and dev. */
  handoverSafe: z.boolean().optional(),
  /** "@트리나 …" in a room asks the AI there (rooms/ai.ts). Off by default since the side chat (docs/DECISIONS.md
   * "Trina side chat", option A): people ask the AI beside a room and share an answer on purpose. On: the old way, for
   * an operator who still wants it while people move over. Earlier answers in rooms stay as they are either way. */
  roomAiMentions: z.boolean().optional(),
  /** The file list (server/src/file-list/; docs/CONFIGURATION.md): `{ "enabled": false }` turns it off on this server
   * whatever the team's admin chooses (no nightly reading by the AI, no _FILES.md lists, no line about them in the AI's
   * instructions). Absent: the team's switch in Admin › Team settings decides (on by default). */
  fileList: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  /** obsolete: the knowledge graph was removed (docs/DECISIONS.md, 2026-11-11). Accepted with any value and ignored,
   * so a file written for an older version still loads; the start logs it once (OBSOLETE_KEYS). */
  knowledgeGraph: z.unknown().optional(),
})
export type AppConfigFile = z.infer<typeof AppConfigFile>

export interface AppConfig {
  mode: 'dev' | 'prod'
  configFile: string | null
  listen: { host: string; port: number }
  /** host: absent = 0.0.0.0 */
  tls: { host?: string; port: number; certFile: string; keyFile: string; managed?: boolean } | null
  /** see AppConfigFile.allowedHosts; absent or empty = any Host */
  allowedHosts?: string[]
  /** see AppConfigFile.allowedPeers; absent or empty = any peer */
  allowedPeers?: string[]
  /** office mode (docs/OFFICE.md) */
  office?: boolean
  /** see AppConfigFile.tunnel; absent or null = no public address */
  tunnel?: { host: string; allowFrom: string[]; countries: string[] } | null
  publicOrigins: string[]
  /** see AppConfigFile.appConnectors */
  appConnectors?: boolean
  teamRoot: string
  dataDir: string
  logDir: string | null
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  engine: {
    authMode: 'local-login' | 'managed'
    /** the older name the file used ('subscription' / 'proxy'), logged once at start */
    authModeAlias?: string
    claudeBin?: string; codexBin?: string; runDir?: string; agentRoot?: string; launcherSock?: string; agentUid?: number; proxyPort?: number
    /** alias of modelUpstreams.anthropic */
    modelUpstream?: string
    /** absent = all four kinds */
    credentialKinds?: CredentialKind[]
    modelUpstreams?: Partial<ModelUpstreams> & { openrouter?: string }
    /** see AppConfigFile engine.anthropicGateway */
    anthropicGateway?: AnthropicGatewayConf
  }
  relay: { url: string | null; teamName: string | null; officialAvailable?: boolean }
  update: { channel: 'stable' | 'beta'; feedUrl: string | null; auto?: boolean }
  /** the native app push gateway; absent or null = no native push (the default) */
  push?: { gatewayUrl?: string | null }
  sourceCode?: SourceCodeConfig
  validateResponses: boolean
  /** see AppConfigFile.deployment; absent = "self" (server/src/system/deployment.ts deploymentOf) */
  deployment?: 'self' | 'hosted'
  /** see AppConfigFile.handoverSafe; absent = off */
  handoverSafe?: boolean
  /** see AppConfigFile.roomAiMentions; absent = off */
  roomAiMentions?: boolean
  /** see AppConfigFile.fileList; absent = the team's switch decides */
  fileList?: { enabled?: boolean }
  /** first-run setup token (POST /api/setup). Dev: printed at start; prod: written by the installer. */
  setupToken: string | null
  /** demo mode (MYCEL_DEMO, `bun run demo:company`): the fictional company's demo people. Only ever set on a development
   * server (readDemoFile); absent everywhere else, and then the demo endpoints answer 404. */
  demo?: DemoFile
  /** keys of the config file that this version ignores (OBSOLETE_KEYS); the start logs them once */
  obsoleteKeys?: string[]
}

/** Config file keys older versions read and this one ignores, with why, for the start's log line. */
export const OBSOLETE_KEYS: Readonly<Record<string, string>> = {
  knowledgeGraph: 'the knowledge graph was removed; the AI finds files with list, glob, grep and read',
}

export class ConfigError extends Error { name = 'ConfigError' }

export interface LoadOptions { argv?: string[]; env?: Record<string, string | undefined>; cwd?: string }

export function loadAppConfig(o: LoadOptions = {}): AppConfig {
  const argv = o.argv ?? process.argv.slice(2)
  const env = o.env ?? process.env
  const cwd = o.cwd ?? process.cwd()
  const P = PRODUCT.envPrefix
  const ai = argv.indexOf('--config')
  const explicit = ai >= 0 ? argv[ai + 1] : env[P + 'CONFIG']
  const modeHint = (env[P + 'MODE'] as 'dev' | 'prod' | undefined) ?? (argv.includes('--prod') ? 'prod' : undefined)
  let file: string | null = null
  if (explicit) file = path.resolve(cwd, explicit)
  else if (modeHint === 'prod') file = path.join(PROD_BASE, 'config', 'server.json')
  else if (fs.existsSync(path.join(DEV_DIR, 'server.json'))) file = path.join(DEV_DIR, 'server.json')

  let raw: unknown = {}
  if (file) {
    if (!fs.existsSync(file)) throw new ConfigError(`config file not found: ${file}`)
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ConfigError(`config file ${file} is not valid JSON: ${(e as Error).message}`) }
  }
  const parsed = AppConfigFile.safeParse(raw)
  if (!parsed.success) throw new ConfigError(`config file ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const f = parsed.data
  const base = file ? path.dirname(file) : cwd
  const abs = (p: string) => path.resolve(base, p)

  const mode = modeHint ?? f.mode ?? 'dev'
  const def = mode === 'dev'
    ? { teamRoot: path.join(DEV_DIR, 'team'), dataDir: path.join(DEV_DIR, 'data'), logDir: null as string | null }
    : { teamRoot: path.join(PROD_BASE, 'team'), dataDir: path.join(PROD_BASE, 'data'), logDir: prodLogDir() }

  const port = env[P + 'PORT'] !== undefined ? Number(env[P + 'PORT']) : f.listen.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`${P}PORT must be a port number`)
  const level = (env[P + 'LOG_LEVEL'] ?? f.logLevel ?? (mode === 'dev' ? 'debug' : 'info')) as AppConfig['logLevel']
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new ConfigError(`${P}LOG_LEVEL must be debug, info, warn or error`)
  const origins = env[P + 'PUBLIC_ORIGINS'] !== undefined ? env[P + 'PUBLIC_ORIGINS']!.split(',').map((s) => s.trim()).filter(Boolean) : f.publicOrigins
  const logDirRaw = env[P + 'LOG_DIR'] ?? (f.logDir === undefined ? def.logDir : f.logDir)
  const depEnv = env[P + 'DEPLOYMENT']
  const dep = depEnv !== undefined && depEnv !== '' ? AppConfigFile.shape.deployment.safeParse(depEnv) : null
  if (dep && !dep.success) throw new ConfigError(`${P}DEPLOYMENT must be self or hosted`)
  const deployment = dep?.data ?? f.deployment
  // the hosted service is never office mode (one Mac in an office): a file that says both is a mistake, not a choice
  if (deployment === 'hosted' && f.office) throw new ConfigError(`config file ${file}: deployment "hosted" cannot be office mode`)
  // two answers to "where do Claude requests go" is a mistake; a local-login engine never uses the proxy
  if (f.engine.anthropicGateway && (f.engine.modelUpstreams?.anthropic || f.engine.modelUpstream)) throw new ConfigError(`config file ${file}: engine.anthropicGateway and engine.modelUpstreams.anthropic (or modelUpstream) cannot both be set`)
  if (f.engine.anthropicGateway && normalizeAuthMode(f.engine.authMode) !== 'managed') throw new ConfigError(`config file ${file}: engine.anthropicGateway needs engine.authMode "managed"`)
  const demo = readDemoFile(env[P + 'DEMO'], { mode, deployment, office: !!f.office }, cwd)
  const obsolete = Object.keys(OBSOLETE_KEYS).filter((k) => (f as Record<string, unknown>)[k] !== undefined)
  const pushGateway = env[P + 'PUSH_GATEWAY'] !== undefined ? (env[P + 'PUSH_GATEWAY'] || null) : (f.push?.gatewayUrl ?? null)
  if (pushGateway !== null && !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(pushGateway) && !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(pushGateway)) throw new ConfigError(`push gateway must be https://<host> or http://127.0.0.1:<port> (${P}PUSH_GATEWAY or push.gatewayUrl)`)

  return {
    mode,
    configFile: file,
    listen: { host: env[P + 'HOST'] ?? f.listen.host, port },
    tls: f.tls ? { host: f.tls.host, port: f.tls.port, certFile: abs(f.tls.certFile), keyFile: abs(f.tls.keyFile), managed: f.tls.managed } : null,
    allowedHosts: f.allowedHosts.map((h) => h.toLowerCase()),
    allowedPeers: f.allowedPeers,
    office: f.office,
    tunnel: f.tunnel,
    publicOrigins: origins,
    appConnectors: f.appConnectors,
    teamRoot: env[P + 'TEAM_ROOT'] ? path.resolve(cwd, env[P + 'TEAM_ROOT']!) : f.teamRoot ? abs(f.teamRoot) : def.teamRoot,
    dataDir: env[P + 'DATA_DIR'] ? path.resolve(cwd, env[P + 'DATA_DIR']!) : f.dataDir ? abs(f.dataDir) : def.dataDir,
    logDir: logDirRaw ? path.resolve(base, logDirRaw) : null,
    logLevel: level,
    engine: {
      authMode: normalizeAuthMode(f.engine.authMode),
      ...(f.engine.authMode === 'subscription' || f.engine.authMode === 'proxy' ? { authModeAlias: f.engine.authMode } : {}),
      claudeBin: f.engine.claudeBin, codexBin: f.engine.codexBin,
      ...(f.engine.runDir ? { runDir: abs(f.engine.runDir) } : {}),
      ...(f.engine.agentRoot ? { agentRoot: abs(f.engine.agentRoot) } : {}),
      ...(f.engine.launcherSock ? { launcherSock: abs(f.engine.launcherSock) } : {}),
      ...(f.engine.agentUid !== undefined ? { agentUid: f.engine.agentUid } : {}),
      ...(f.engine.proxyPort !== undefined ? { proxyPort: f.engine.proxyPort } : {}),
      ...(f.engine.modelUpstream ? { modelUpstream: f.engine.modelUpstream } : {}),
      ...(f.engine.credentialKinds ? { credentialKinds: [...new Set(f.engine.credentialKinds)] } : {}),
      ...(f.engine.modelUpstreams ? { modelUpstreams: f.engine.modelUpstreams } : {}),
      ...(f.engine.anthropicGateway ? { anthropicGateway: f.engine.anthropicGateway } : {}),
    },
    relay: {
      url: env[P + 'RELAY_URL'] !== undefined ? (env[P + 'RELAY_URL'] || null) : f.relay.url,
      teamName: env[P + 'RELAY_TEAM'] ?? f.relay.teamName,
      officialAvailable: env[P + 'RELAY_OFFICIAL'] !== undefined ? env[P + 'RELAY_OFFICIAL'] === '1' : f.relay.officialAvailable,
    },
    update: f.update,
    push: { gatewayUrl: pushGateway },
    ...(f.sourceCode ? { sourceCode: f.sourceCode } : {}),
    validateResponses: f.validateResponses ?? mode === 'dev',
    setupToken: env[P + 'SETUP_TOKEN'] ?? null,
    ...(deployment ? { deployment } : {}),
    ...(f.handoverSafe ? { handoverSafe: true } : {}),
    ...(f.roomAiMentions ? { roomAiMentions: true } : {}),
    ...(f.fileList ? { fileList: f.fileList } : {}),
    ...(demo ? { demo } : {}),
    ...(obsolete.length ? { obsoleteKeys: obsolete } : {}),
  }
}

/**
 * MYCEL_DEMO=<file>: the demo company's people (docs/DECISIONS.md "Demo company: a new hire at 트리나"). The product has
 * no "sign in as someone else"; the demo's switch between its fictional people exists only on a development server
 * started for the demo. So the flag stops the server everywhere else (production mode, the hosted service, office mode),
 * as does a file that is missing or not a demo file. Unset or empty: no demo (null).
 */
export function readDemoFile(value: string | undefined, where: { mode: 'dev' | 'prod'; deployment?: 'self' | 'hosted'; office: boolean }, cwd = process.cwd()): DemoFile | null {
  if (value === undefined || value === '') return null
  const P = PRODUCT.envPrefix
  if (where.mode !== 'dev' || where.deployment === 'hosted' || where.office) {
    throw new ConfigError(`${P}DEMO is for a development demo server only (\`bun run demo:company\`): remove it from this server's environment. It is never allowed in production mode, on the hosted service or in office mode.`)
  }
  const file = path.resolve(cwd, value)
  let raw: unknown
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new ConfigError(`${P}DEMO: cannot read the demo file ${file}: ${(e as Error).message}`) }
  const parsed = DemoFile.safeParse(raw)
  if (!parsed.success) throw new ConfigError(`${P}DEMO: ${file} is not a demo file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}

/** The AI connection kinds this server allows: engine.credentialKinds, else the deployment's default — all four on a
 * self-installed server or office Mac and on the hosted service (shared/src/cloud-protocol
 * CLOUD_DEFAULT_CREDENTIAL_KINDS, the list mycel-enroll writes; owner's decision 2026-10-22). Subscription kinds always
 * need the D23 notice; the control plane can narrow the list fleet-wide with set-server-config.
 * With engine.anthropicGateway: never anthropic-oauth (a Claude subscription token is not sent to a third party), and
 * `gateway` names the gateway an anthropic-api-key connection must have been made for (credentials/store.ts unusable). */
export function allowedCredentialKinds(config: Pick<AppConfig, 'engine'> & { deployment?: AppConfig['deployment'] }): Set<CredentialKind> & { gateway: string | null } {
  const kinds = new Set(config.engine.credentialKinds?.length ? config.engine.credentialKinds : config.deployment === 'hosted' ? CLOUD_DEFAULT_CREDENTIAL_KINDS : ALL_CREDENTIAL_KINDS)
  const g = config.engine.anthropicGateway
  if (g) kinds.delete('anthropic-oauth')
  return Object.assign(kinds, { gateway: g ? gatewayHost(g) : null })
}
/** The AI connections a server allows: the kinds, and which gateway (its host; null = Anthropic itself) an Anthropic
 * API key connection is for. A plain set of kinds (tests) means no gateway. */
export type AllowedKinds = ReadonlySet<CredentialKind> & { readonly gateway?: string | null }

/** engine.anthropicGateway, or null (Claude requests go to Anthropic) */
export const anthropicGateway = (config: Pick<AppConfig, 'engine'>): AnthropicGatewayConf | null => config.engine.anthropicGateway ?? null
/** the gateway's host (with a port when it has one): what an AI connection made for it remembers */
export const gatewayHost = (g: Pick<AnthropicGatewayConf, 'baseUrl'>) => new URL(g.baseUrl).host
export const gatewayLabel = (g: Pick<AnthropicGatewayConf, 'baseUrl' | 'label'>) => g.label ?? gatewayHost(g)
/** OpenRouter (its key is checked on GET /api/v1/key, it reports what a request cost) */
export const isOpenRouter = (g: Pick<AnthropicGatewayConf, 'baseUrl'>) => gatewayHost(g) === 'openrouter.ai'
/** the model ids the proxy forwards to the gateway: the default first, no repeats */
export const gatewayModelIds = (g: Pick<AnthropicGatewayConf, 'models'>): string[] =>
  [...new Set([g.models.default, g.models.opus, g.models.sonnet, g.models.haiku].filter((m): m is string => !!m))]

/** Where the model proxy sends each family: engine.anthropicGateway or engine.modelUpstreams (never both),
 * modelUpstream (= anthropic), the real services. */
export function modelUpstreams(config: Pick<AppConfig, 'engine'>): ModelUpstreams {
  const o = config.engine.modelUpstreams ?? {}
  const trim = (u: string) => u.replace(/\/+$/, '')
  return {
    anthropic: trim(config.engine.anthropicGateway?.baseUrl ?? o.anthropic ?? config.engine.modelUpstream ?? DEFAULT_UPSTREAMS.anthropic),
    openai: trim(o.openai ?? DEFAULT_UPSTREAMS.openai),
    chatgpt: trim(o.chatgpt ?? DEFAULT_UPSTREAMS.chatgpt),
    openaiAuth: trim(o.openaiAuth ?? DEFAULT_UPSTREAMS.openaiAuth),
  }
}

/** OpenRouter's OpenAI-compatible API: the hosting service's trial credit answers there (credentials/hosted-chat.ts) */
export const OPENROUTER_API = 'https://openrouter.ai/api/v1'
/** where trial answers go: OpenRouter, or engine.modelUpstreams.openrouter (tests) */
export const openRouterUpstream = (config: Pick<AppConfig, 'engine'>): string =>
  (config.engine.modelUpstreams?.openrouter ?? OPENROUTER_API).replace(/\/+$/, '')

/** managed mode (the team's AI connections behind the model proxy) */
export const isManaged = (config: Pick<AppConfig, 'engine'>) => config.engine.authMode === 'managed'
