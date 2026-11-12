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
//
// Since QA TC-133 also every service in the app's list (shared/src/service-catalog.ts, by its id: "notion", "linear"
// …): it is added for a member once a team connection to its official address exists that they may use. A member may
// take their own open request back; the owner and the admins see the open requests in Admin › Connectors and may
// dismiss them.
import { z } from 'zod'
import { IsoTime } from './common'
import { endpoint, empty } from './endpoint'
import { SERVICE_CATALOG } from '../service-catalog'

/** The apps an admin sets up once for everyone: Google Drive and the Google apps (their ids on the Connectors page). */
export const GOOGLE_REQUESTABLE = ['google-drive', 'gmail', 'calendar', 'docs', 'sheets'] as const
/** What can be asked for: those, and every listed service by its id (/connectors/<id>). Never anything else. */
export const REQUESTABLE_SERVICES = [...GOOGLE_REQUESTABLE, ...SERVICE_CATALOG.map((c) => c.id)] as [typeof GOOGLE_REQUESTABLE[number], ...(typeof GOOGLE_REQUESTABLE[number] | (typeof SERVICE_CATALOG)[number]['id'])[]]
export const RequestableService = z.enum(REQUESTABLE_SERVICES)
export type RequestableService = z.infer<typeof RequestableService>
export const isRequestableService = (s: unknown): s is RequestableService => typeof s === 'string' && (REQUESTABLE_SERVICES as readonly string[]).includes(s)
/** One of the Google ones (set up once in Admin), not a listed service (a team connection) */
export const isGoogleRequestable = (s: unknown): s is (typeof GOOGLE_REQUESTABLE)[number] => typeof s === 'string' && (GOOGLE_REQUESTABLE as readonly string[]).includes(s)

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

/** The open requests for one service, as the owner and the admins see them (Admin › Connectors): who asked, newest
 * first, and when the newest did. */
export const TeamServiceRequest = z.object({
  service: RequestableService,
  askers: z.array(z.object({ id: z.string(), name: z.string() })),
  askedAt: IsoTime,
})
export type TeamServiceRequest = z.infer<typeof TeamServiceRequest>

export const SERVICE_REQUESTS = {
  myServiceRequests: endpoint({ method: 'GET', path: '/api/integrations/service-requests', auth: 'user', owner: 'C', response: z.object({ items: z.array(ServiceRequest) }),
    summary: 'The apps I asked an admin to add that are not added yet. Owners and admins have none.' }),
  askService: endpoint({ method: 'POST', path: '/api/integrations/service-requests', auth: 'user', owner: 'C', body: AskServiceBody, response: AskServiceResult,
    summary: 'Ask the owner and admins to add an app the team has not set up (members only; 400 unknown_service, 409 can_connect or not_requestable, 429 after 10 a day). One open request per app; tells them in the app, never names an admin.' }),
  withdrawService: endpoint({ method: 'DELETE', path: '/api/integrations/service-requests/:service', auth: 'user', owner: 'C', response: empty, status: 204,
    summary: 'Take back my own open request for an app (nothing happens when there is none). It still counts toward the 10 a day.' }),
  teamServiceRequests: endpoint({ method: 'GET', path: '/api/admin/service-requests', auth: 'admin', owner: 'C', response: z.object({ items: z.array(TeamServiceRequest) }),
    summary: 'The open requests to add an app, by app: who asked and when (owners and admins).' }),
  dismissServiceRequests: endpoint({ method: 'POST', path: '/api/admin/service-requests/:service/dismiss', auth: 'admin', owner: 'C', body: z.object({}).strict(), response: empty, status: 204,
    summary: 'Close the open requests for an app without adding it (nobody is told; members may ask again).' }),
} as const
