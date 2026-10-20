// Route module contract. One file per area, one owner per file (docs/WORKPLAN.md), so parallel work never edits
// the same file. The list of modules is in ./index.ts (already contains every module; owners don't edit it).
import type { Owner } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'

export interface RouteModule {
  name: string
  owner: Owner
  /** Install this component's services into ctx.services (runs for every module before any register()). */
  init?(ctx: AppContext): void | Promise<void>
  /** Implement endpoints: kit.handle(API.x, handler). Off-contract routes: kit.raw(...). */
  register(kit: RouteKit, ctx: AppContext): void
}
