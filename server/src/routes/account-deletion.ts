// A person's request to have their own account deleted (contract: shared/src/api/account-deletion.ts), registered by
// the auth route module (owner A). Only the caller's own request: the person comes from the session, never from the
// request. The owner deletes the account in Admin › Members (DELETE /api/admin/users/:id).
import { API } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { RouteKit } from '../http/route'
import { cancelAccountDeletion, myDeletionRequest, requestAccountDeletion } from '../auth/deletion-requests'

export function registerAccountDeletionRoutes(kit: RouteKit, ctx: AppContext): void {
  kit.handle(API.myDeletionRequest, ({ c }) => myDeletionRequest(c, ctx))
  kit.handle(API.requestAccountDeletion, ({ c }) => requestAccountDeletion(c, ctx))
  kit.handle(API.cancelAccountDeletion, ({ c }) => cancelAccountDeletion(c, ctx))
}
