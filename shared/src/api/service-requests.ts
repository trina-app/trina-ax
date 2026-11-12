// A member asks the owner and the admins to add an app the team has not set up (docs/INTEGRATIONS.md "A member asks for
// an app"). Owner: C (server/src/integrations/service-requests.ts, registered by server/src/routes/google-apps.ts;
// tables: server/migrations/343_c_service_requests.sql).
//
// Only the apps an admin sets up once for the whole team can be asked for: Google Drive and the Google apps, while
// they are not set up. Anything else is refused, and so is an app the member can already connect, one the team turned
// off for members, and an ask from an owner or admin (they set it up themselves). One open request per member and app;
// asking again while it is open changes nothing ("already"). The owner and the admins get one inbox notice per app
// ('service.request': who asked, by name, and how many), which opens the app's setup; when the member can connect it,
// the requests close and each member who asked gets one quiet notice ('service.ready', never an OS push). Answers to a
// member never name an admin.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint } from './endpoint'

/** What can be asked for: Google Drive and the Google apps (their ids on the Connectors page, /connectors/<id>). */
export const REQUESTABLE_SERVICES = ['google-drive', 'gmail', 'calendar', 'docs', 'sheets'] as const
export const RequestableService = z.enum(REQUESTABLE_SERVICES)
export type RequestableService = z.infer<typeof RequestableService>
export const isRequestableService = (s: unknown): s is RequestableService => typeof s === 'string' && (REQUESTABLE_SERVICES as readonly string[]).includes(s)

/** At most this many requests a member may make in a day (one open request per app keeps it to five at a time). */
export const SERVICE_REQUESTS_PER_DAY = 10

/** One of my open requests. */
export const ServiceRequest = z.object({ service: RequestableService, askedAt: IsoTime })
export type ServiceRequest = z.infer<typeof ServiceRequest>

/** `service`: checked by the server against REQUESTABLE_SERVICES (an unknown name is refused, 400 unknown_service). */
export const AskServiceBody = z.object({ service: z.string().min(1).max(64) }).strict()
export type AskServiceBody = z.infer<typeof AskServiceBody>

/** sent: this ask opened the request · already: one was open (nothing was sent again) */
export const AskServiceResult = z.object({ service: RequestableService, state: z.enum(['sent', 'already']), askedAt: IsoTime })
export type AskServiceResult = z.infer<typeof AskServiceResult>

export const SERVICE_REQUESTS = {
  myServiceRequests: endpoint({ method: 'GET', path: '/api/integrations/service-requests', auth: 'user', owner: 'C', response: z.object({ items: z.array(ServiceRequest) }),
    summary: 'The apps I asked an admin to add that are not added yet. Owners and admins have none.' }),
  askService: endpoint({ method: 'POST', path: '/api/integrations/service-requests', auth: 'user', owner: 'C', body: AskServiceBody, response: AskServiceResult,
    summary: 'Ask the owner and admins to add an app the team has not set up (members only; 400 unknown_service, 409 can_connect or not_requestable, 429 after 10 a day). One open request per app; tells them in the app, never names an admin.' }),
} as const
