// Server-side account CLI (run on the server Mac; access to the Mac is the trust anchor, tab 4 "비밀번호 재설정").
//
//   bun server/src/auth/cli.ts status
//   bun server/src/auth/cli.ts create-owner --username kim --name "Kim" --team "Acme" [--locale en|ko|id] < password
//   bun server/src/auth/cli.ts reset-link [--username kim]      one-time link (24 h) for the owner or the named member
//
// Uses the same config as the server (--config / MYCEL_* env). The password is read from stdin, never from argv.
import { PRODUCT } from '@mycel/shared'
import { DEFAULT_LOCALE, Locale, PersonName, Username } from '@mycel/shared/api'
import { loadAppConfig, type AppConfig } from '../app-config'
import { createContext, type AppContext } from '../context'
import { openDb } from '../db'
import { silentLogger } from '../log'
import path from 'node:path'
import { bootstrapOwner, createResetLink, setupStatus, userCount } from './accounts'
import { passwordProblem } from './passwords'
import { installAuth } from './service'
import { getUserByUsername } from './users'

export class CliError extends Error {}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

export function openCliContext(cfg: AppConfig): AppContext {
  const db = openDb(path.join(cfg.dataDir, 'app.db'))
  const ctx = createContext({ config: cfg, db, log: silentLogger })
  ctx.onClose(() => db.close())
  installAuth(ctx)
  return ctx
}

/** Returns the text to print. Throws CliError for user mistakes. */
export async function runCli(argv: string[], o: { config?: AppConfig; stdin?: () => Promise<string> } = {}): Promise<string> {
  const cmd = argv[0]
  const cfg = o.config ?? loadAppConfig({ argv: argv.slice(1) })
  const ctx = openCliContext(cfg)
  try {
    switch (cmd) {
      case 'status': {
        const s = setupStatus(ctx)
        return s.needed ? 'setup needed: no account yet (run create-owner, or open the setup page)' : `team "${s.teamName}" is set up (${userCount(ctx.db)} accounts)`
      }
      case 'create-owner': {
        const username = Username.safeParse(arg(argv, 'username'))
        const name = PersonName.safeParse(arg(argv, 'name'))
        const team = arg(argv, 'team')?.trim()
        const locale = Locale.safeParse(arg(argv, 'locale') ?? DEFAULT_LOCALE)
        if (!username.success) throw new CliError('--username: letters, digits, ".", "_", "@", "-" (2-64)')
        if (!name.success) throw new CliError('--name is required')
        if (!team) throw new CliError('--team is required')
        if (!locale.success) throw new CliError('--locale must be ko, en or id')
        if (userCount(ctx.db) > 0) throw new CliError('this team server is already set up')
        const pw = ((await (o.stdin ?? readStdin)()) ?? '').replace(/\r?\n$/, '')
        const problem = passwordProblem(pw, { username: username.data })
        if (problem) throw new CliError(`password: ${problem}`)
        const id = await bootstrapOwner(ctx, { username: username.data, name: name.data, password: pw, teamName: team, locale: locale.data })
        return `owner "${username.data}" created (id ${id}); team "${team}"`
      }
      case 'reset-link': {
        const u = arg(argv, 'username')
        const row = u
          ? getUserByUsername(ctx.db, u)
          : (ctx.db.query("SELECT username FROM users WHERE role = 'owner' AND deleted_at IS NULL LIMIT 1").get() as { username: string } | null)
        const user = row ? getUserByUsername(ctx.db, row.username) : null
        if (!user) throw new CliError(u ? `no account "${u}"` : 'no owner yet (run create-owner)')
        if (user.status !== 'active') throw new CliError(`account "${user.username}" is disabled`)
        const base = cfg.publicOrigins[0] ?? `http://localhost:${cfg.listen.port}`
        const link = createResetLink(ctx, user.id, null, base)
        return `one-time password reset link for "${user.username}" (valid until ${link.expiresAt}):\n${link.url}`
      }
      default:
        throw new CliError(`usage: ${PRODUCT.id}-admin status | create-owner --username U --name N --team T [--locale en|ko|id] < password | reset-link [--username U]`)
    }
  } finally {
    await ctx.close()
  }
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text()
}

if (import.meta.main) {
  try {
    console.log(await runCli(process.argv.slice(2)))
  } catch (e) {
    console.error(e instanceof CliError ? e.message : (e as Error).stack ?? String(e))
    process.exit(e instanceof CliError ? 2 : 1)
  }
}
