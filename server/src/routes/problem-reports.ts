// Route module "problem-reports" (docs/decisions/20261126-problem-reports.md). Implements: PROBLEM_REPORTS
// (shared/src/api/problem-reports.ts). Logic and the sender: server/src/system/problem-reports.ts. The person comes from
// the session; an answer's chat is checked with the chat's own access rule (chat/shared.ts chatFor), so a report can
// only name an answer its sender can open.
import { API } from '@mycel/shared/api'
import { getChatRuntime } from '../chat/runtime'
import { chatFor } from '../chat/shared'
import { fail } from '../http/errors'
import { startProblemReports, submitProblemReport } from '../system/problem-reports'
import type { RouteModule } from './module'

export const problemReportsRoutes: RouteModule = {
  name: 'problem-reports',
  owner: 'G',
  register(kit, ctx) {
    startProblemReports(ctx)
    kit.handle(API.sendProblemReport, ({ c, auth, body }) => {
      if (auth.user.role === 'guest') fail('forbidden')
      const rt = getChatRuntime(ctx)
      const canView = (chatId: string) => { try { chatFor(rt, auth.user.id, chatId, 'view'); return true } catch { return false } }
      // the client kind from the session, not from the body
      const kind = auth.session.client === 'mobile' ? 'phone' : auth.session.client === 'desktop' ? 'desktop' : 'web'
      return submitProblemReport(ctx, auth.user.id, { ...body, client: { ...body.client, kind } }, c.get('locale') ?? auth.user.locale, canView)
    })
  },
}
