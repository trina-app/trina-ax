// How this server is installed (linux-runtime D24: server.json `deployment`, "self" or "hosted"). The key itself belongs
// to the deployment-flag work (app-config.ts, feat/cloud-linux-server); this reads it without depending on that change,
// so either branch can land first: a config without the key is a self-installed server, as today.
//
// Office mode and dev stay what the existing switches say (`office`, `mode`); together with this key they give the
// way the server runs (runKindOf: hosted, selfhost, office, dev), and the feature table below decides what each may
// do: routes ask feature(), the web reads the same values from GET /api/me (server.deployment, server.features).
// docs/DECISIONS.md "클라우드·리눅스 서버".
import type { AppConfig } from '../app-config'

export type Deployment = 'self' | 'hosted'

export function deploymentOf(cfg: AppConfig | Record<string, unknown>): Deployment {
  return (cfg as { deployment?: unknown }).deployment === 'hosted' ? 'hosted' : 'self'
}

/** A hosted-service tenant: the control plane registers the relay address, applies updates, holds the plan. */
export function isHosted(cfg: AppConfig | Record<string, unknown>): boolean {
  return deploymentOf(cfg) === 'hosted'
}

/** The way this server runs: the hosted service, a customer's own server (Linux or the Mac role-account install),
 * office mode (one Mac in a small office), or development. */
export type RunKind = 'hosted' | 'selfhost' | 'office' | 'dev'
type Cfg = Pick<AppConfig, 'mode'> & Partial<Pick<AppConfig, 'office' | 'deployment'>>

export function runKindOf(cfg: Cfg): RunKind {
  if (isHosted(cfg as Record<string, unknown>)) return 'hosted'
  if (cfg.office) return 'office'
  return cfg.mode === 'dev' ? 'dev' : 'selfhost'
}

export interface Features {
  /** change the connection mode / relay address in server.json (Admin > System > Connection). Hosted: the operator
   * owns server.json and the relay registration; office: its supervisor rewrites server.json at every start. */
  connectionChange: boolean
  /** the in-app update and roll-back endpoints (POST /api/admin/update). Hosted: the control plane drives updates. */
  selfUpdate: boolean
  /** office mode's own nightly update agent (POST /api/admin/office-update) */
  officeUpdate: boolean
  /** connected folders (a folder of the server mirrored into connected/<name>). Hosted tenants have no mounted shares. */
  connectedFolders: boolean
  /** the team API engine may use any http(s) address (a local Ollama). Hosted: https to public addresses only. */
  apiEngineAnyUrl: boolean
  /** diagnostics show machine-level items (the host volume's free space, firewall and launcher commands). Hosted: the
   * team's own items, with wording that points at the admin screens and support. */
  hostDiagnostics: boolean
  /** install plugins from package files (an upload in Admin > Plugins, or <data>/plugins/import). Hosted: tenants take
   * official catalog packages only; the operator manages the server runtime (docs/PLUGINS.md). */
  pluginFileInstall: boolean
}

const TABLE: Record<RunKind, Features> = {
  hosted: { connectionChange: false, selfUpdate: false, officeUpdate: false, connectedFolders: false, apiEngineAnyUrl: false, hostDiagnostics: false, pluginFileInstall: false },
  selfhost: { connectionChange: true, selfUpdate: true, officeUpdate: false, connectedFolders: true, apiEngineAnyUrl: true, hostDiagnostics: true, pluginFileInstall: true },
  office: { connectionChange: false, selfUpdate: true, officeUpdate: true, connectedFolders: true, apiEngineAnyUrl: true, hostDiagnostics: true, pluginFileInstall: true },
  dev: { connectionChange: true, selfUpdate: true, officeUpdate: false, connectedFolders: true, apiEngineAnyUrl: true, hostDiagnostics: true, pluginFileInstall: true },
}

export function featuresOf(cfg: Cfg): Features { return { ...TABLE[runKindOf(cfg)] } }
export function feature(cfg: Cfg, name: keyof Features): boolean { return TABLE[runKindOf(cfg)][name] }

/**
 * Which machine the wording talks about (system/messages-linux.ts): 'mac' (the role-account install, office mode, dev
 * on a Mac: the Mac wording, unchanged), 'linux' (the customer's own Linux server: systemctl, journalctl, sudo on the
 * server), 'hosted' (the hosted service: the customer has no server to log in to; everything points at the admin
 * screens and support).
 */
export type HostKind = 'mac' | 'linux' | 'hosted'
export function hostKind(cfg: Cfg, platform: NodeJS.Platform = process.platform): HostKind {
  if (runKindOf(cfg) === 'hosted') return 'hosted'
  if (cfg.office || platform === 'darwin') return 'mac'
  return 'linux'
}
