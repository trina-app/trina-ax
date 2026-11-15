// The checks that fail on a fresh hosted team (FRESH_TEAM_FAILING_CHECKS, shared/src/cloud-protocol/tenant-commands.ts).
// Trina Cloud's update gate (rule F-14) reads the status a team server reports after an update. It rolled back every
// update of teams that had never added an AI connection, because their overall status is `fail` from the first day
// (engine.claude-code). The gate now rolls back only on checks that were not failing before, and it knows the list.
// This test runs the diagnostics of a hosted team as it is right after its install (a healthy host, nobody has set
// anything up) and compares the failing checks with that list: a new check that fails on such a team breaks it, so
// whoever adds one updates the list and tells the control plane.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { LauncherStatus } from '@mycel/shared'
import { FRESH_TEAM_FAILING_CHECKS } from '../../shared/src/cloud-protocol/tenant-commands'
import type { AppConfig } from '../../server/src/app-config'
import { createContext, type AppContext } from '../../server/src/context'
import { openDb } from '../../server/src/db'
import { silentLogger } from '../../server/src/log'
import { resolveLayout } from '../../server/src/system/layout'
import { OpsService } from '../../server/src/system/ops'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mycel-fresh-')))
const base = path.join(root, 'b')
const sock = path.join(root, 'l.sock')
const procSys = path.join(root, 'proc-sys')
let ctx: AppContext
let server: net.Server
// the host as the hosting service provisions it: launcher up with its sandbox, firewall loaded, kernel isolation on
const launcher: LauncherStatus = { ev: 'status', os: 'linux', sandbox: 'bwrap', bwrapVersion: '0.12.0', landlockAbi: 6, landlockMode: 'required-scoped', scoped: true, seccomp: true, cgroup: 'delegated', liveTurns: 0, maxLiveTurns: 4, firewall: { loaded: true, at: null } }

beforeAll(async () => {
  for (const d of ['run', 'root', 'config', 'data', 'team', 'secrets', 'status', 'bin']) fs.mkdirSync(path.join(base, d), { recursive: true })
  fs.mkdirSync(path.join(procSys, 'kernel', 'yama'), { recursive: true })
  fs.mkdirSync(path.join(procSys, 'user'), { recursive: true })
  fs.writeFileSync(path.join(procSys, 'kernel', 'yama', 'ptrace_scope'), '1\n')
  fs.writeFileSync(path.join(procSys, 'user', 'max_user_namespaces'), '15000\n')
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true })
  fs.writeFileSync(path.join(base, 'run', 'firewall.json'), JSON.stringify({ format: 1, at: new Date().toISOString(), backend: 'nftables', table: 'inet mycel', loaded: true, rules: 7, engineUid: 990, proxyPort: 47821, sha256: 'x', error: null }))
  // both engines are installed in the hosted image; whether they can run is the team's AI connections (managed mode)
  for (const bin of ['claude', 'codex']) fs.writeFileSync(path.join(base, 'bin', bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  server = net.createServer((c) => c.end()).listen(sock)
  await new Promise((r) => server.once('listening', r))
  const cfg: AppConfig = {
    mode: 'prod', deployment: 'hosted', configFile: path.join(base, 'config', 'server.json'), listen: { host: '127.0.0.1', port: 0 }, tls: null, publicOrigins: [],
    teamRoot: path.join(base, 'team'), dataDir: path.join(base, 'data'), logDir: null, logLevel: 'error',
    engine: { authMode: 'managed', launcherSock: sock, agentUid: 990, runDir: path.join(root, 'r'), claudeBin: path.join(base, 'bin', 'claude'), codexBin: path.join(base, 'bin', 'codex') },
    relay: { url: null, teamName: null }, update: { channel: 'stable', feedUrl: null },
    validateResponses: false, setupToken: null,
  }
  ctx = createContext({ config: cfg, db: openDb(path.join(cfg.dataDir, 'app.db')), log: silentLogger })
})
afterAll(async () => { server.close(); await ctx.close(); fs.rmSync(root, { recursive: true, force: true }) })

test('a fresh hosted team fails exactly the checks in FRESH_TEAM_FAILING_CHECKS (Trina Cloud update gate, rule F-14)', async () => {
  const layout = resolveLayout(ctx.config, { MYCEL_INSTALL_BASE: base, MYCEL_LABEL: 'mycel' }, 'linux')
  // no `engines` override: the real engine check reads the team's (empty) AI connections
  const ops = new OpsService(ctx, { layout, platform: 'linux', launcherStatus: async () => launcher, procSysDir: procSys, atDir: path.join(root, 'etc') })
  // the status file is what the hosting service reads (mycel-ctl status → TenantStatus.checks and overall)
  const s = await ops.statusFile()
  const failing = (s.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id).sort()
  expect(failing, 'a check fails on a fresh hosted team that is not in FRESH_TEAM_FAILING_CHECKS (or no longer fails): update the list and tell the Trina Cloud update gate (F-14)')
    .toEqual([...FRESH_TEAM_FAILING_CHECKS].sort())
  // and the list is why such a team reports `fail` overall
  expect(s.overall === 'fail').toBe(FRESH_TEAM_FAILING_CHECKS.length > 0)
})
