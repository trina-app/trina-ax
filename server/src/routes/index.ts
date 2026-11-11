// Every route module, registered in this order (web last: its catch-all GET serves the app shell).
// Owners never edit this file: each owns its module file (docs/WORKPLAN.md).
import { adminRoutes } from './admin'
import { peopleRoutes } from './people'
import { artifactsRoutes } from './artifacts'
import { authRoutes } from './auth'
import { browserRoutes } from './browser'
import { chatsRoutes } from './chats'
import { filesRoutes } from './files'
import { jobsRoutes } from './jobs'
import { memoriesRoutes } from './memories'
import type { RouteModule } from './module'
import { officeUpdateRoutes } from './office-update'
import { relayRoutes } from './relay'
import { systemRoutes } from './system'
import { webRoutes } from './web'
import { wsRoutes } from './ws'
import { remoteMcpRoutes } from './remote-mcp'
import { devEnvRoutes } from './dev-env'
import { onboardingPacksRoutes } from './onboarding-packs'
import { onboardingRoutes } from './onboarding'
import { onboardingWelcomeRoutes } from './onboarding-welcome'
import { onboardingFilesRoutes } from './onboarding-files'
import { promoVideoRoutes } from './promo-video'
import { introDeckRoutes } from './intro-deck'
import { onboardingGoalRoutes } from './onboarding-goal'
import { memberWelcomeRoutes } from './member-welcome'
import { skillSharesRoutes } from './skill-shares'
import { demoRoutes } from './demo'
import { roomsRoutes } from './rooms'
import { slackRoutes } from './slack'
import { appLinksRoutes } from './app-links'
import { oftenAskedRoutes } from './often-asked'

export type { RouteModule } from './module'

export const ROUTE_MODULES: readonly RouteModule[] = [
  systemRoutes, // G
  officeUpdateRoutes, // G (office mode automatic updates)
  authRoutes, // A
  adminRoutes, // A
  peopleRoutes, // A (profiles and the people directory)
  chatsRoutes, // B
  memoriesRoutes, // B
  roomsRoutes, // B (team chat rooms, docs/DECISIONS.md "대화방 v1")
  wsRoutes, // B
  browserRoutes, // B
  filesRoutes, // C
  artifactsRoutes, // C
  jobsRoutes, // C
  relayRoutes, // F
  remoteMcpRoutes, // Optional external apps, separate OAuth audience and core file permissions.
  devEnvRoutes, // dev environment EXPERIMENT (feat/dev-env; 404 unless MYCEL_DEV_ENV=1)
  onboardingPacksRoutes, // recommended skill packs (onboarding stream C)
  onboardingRoutes, // onboarding: the company profile and its drafts (docs/DECISIONS.md "D — Company profile")
  onboardingWelcomeRoutes, // onboarding: the welcome steps' progress (docs/DECISIONS.md "W — Welcome steps")
  onboardingFilesRoutes, // onboarding: 팀 파일's AI picks and its upload run's record (docs/DECISIONS.md "W6")
  promoVideoRoutes, // the company's promo video and its MP4 (docs/DECISIONS.md "V")
  introDeckRoutes, // the company's intro deck as PowerPoint and PDF (docs/DECISIONS.md "D2")
  onboardingGoalRoutes, // onboarding: the 7-day team goal (docs/DECISIONS.md "G — The 7-day team goal")
  memberWelcomeRoutes, // onboarding: the welcome card for invited people (docs/DECISIONS.md "A welcome for invited people")
  skillSharesRoutes, // B: 내 스킬 가져오기, an owner's skills shared with the team (docs/DECISIONS.md "SK")
  oftenAskedRoutes, // B: Home's "what my group often asks" and its daily run (docs/DECISIONS.md "Home: what my group often asks")
  slackRoutes, // C: the Slack connector (docs/SLACK.md); after chats, whose runtime its questions use
  demoRoutes, // demo company (`bun run demo:company`; 404 unless a development server runs with MYCEL_DEMO)
  appLinksRoutes, // G: /.well-known files for the phone app's links (docs/DECISIONS.md "First run, phase 2")
  webRoutes, // D (catch-all, keep last)
]
