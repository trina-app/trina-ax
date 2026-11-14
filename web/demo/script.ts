// The content format of the hands-on demo (docs/AGENTS/plan/20261114-0507-mina-demo.md): one story, written as a
// TypeScript module that default-exports a `DemoScript`. The demo build (`bun run build:demo`) runs the real web app
// against a scripted backend in the browser and plays this story; nothing here reaches a server or an AI.
//
// Where content lives: one story per language, `scripts/demo/mina/<locale>/index.ts` (default export; en first, then
// ko, id, ja, es with no code change), or `scripts/demo/mina/index.ts` for one language. The build picks the language
// with DEMO_LOCALE (default en). Pictures and files are in `assets/` next to the story file, or in the shared
// `scripts/demo/mina/assets/` (a language's own file of the same name wins). Without a story the build plays
// `web/demo/example/index.ts`. The demo's own words around the story ("Start over", the badge) are app i18n keys
// (demo.*); every story word (guide line, fallback, end card) comes from here.
//
// Rules for content: fictional company and people only (no real persons, brands or addresses); every person is a
// plain member (DECISIONS "Demo company"); words in the story's language. Keep it short: the whole
// story is about 10 clicks.
//
// Ids: every person, group, room, project, answer and event has a short id of your choice (`[a-z0-9-]+`), used to
// refer to it elsewhere in the script. The engine turns them into the app's own ids.
//
// Text: Markdown, as an AI answer or a chat message shows it. In any text, `{{project:<id>}}` becomes a link to that
// project's shared chat, `{{room:<id>}}` a link to that room, `{{file:<path>}}` a link to that team file.
import type { Locale } from '@mycel/shared/api'

/** A person's, group's, room's, project's, answer's or event's id in this script. */
export type Id = string

/** A file in the content's `assets/` folder (a file name, e.g. "banner-leo.png"). */
export type Asset = string

export interface DemoScript {
  /** the format's version; this file describes 1 */
  version: 1
  /** the story's language (en, ko, ja, es, id): the app shows its own words in it too */
  locale: Locale
  /** the fictional company: the team's name in the app */
  company: { name: string }
  /** the visitor (one of `people`): signed in as them */
  visitor: Id
  people: DemoPerson[]
  /** team groups; a `team` room names its group */
  groups: DemoGroup[]
  /** the visitor's rooms: team rooms (#마케팅), DMs, group chats, the everyone room; with what was said before */
  rooms: DemoRoom[]
  /** team projects (each has a shared project chat) */
  projects: DemoProject[]
  /** team files, created at the start (projects/<name>/…, groups/<group>/…, shared/…) */
  files: DemoFile[]
  /** chapter 1: Home's welcome card and its one button */
  home: {
    /** the card's title, e.g. "신입사원 미나님, 입사를 축하합니다" */
    title: string
    /** the question the card's button sends to the AI; must be the `prompt` of one of `answers` */
    prompt: string
    /** the button's label (default: the app's own "Ask") */
    button?: string
    /** who invited the visitor: "<name> invited you" on the app's welcome card (default: the first event's sender) */
    inviter?: Id
  }
  /** the canned AI answers; the visitor's message is matched to `prompt` (trimmed, exact) */
  answers: DemoAnswer[]
  /** messages from the story's people, each sent when its trigger happens */
  events: DemoEvent[]
  /** the one line in the screen corner that says what to do next, in order */
  guide: DemoGuideStep[]
  /** free typing: the visitor sent something that is no scripted prompt. The engine answers this text and adds a
   * card whose buttons are the prompts the current guide step suggests (or every prompt for that place) */
  fallback: { text: string; question?: string }
  /** the end card */
  end: DemoEnd
}

export interface DemoPerson {
  id: Id
  /** the name shown in the app, e.g. "김미나" */
  name: string
  /** a job title, shown in the guide and people's profile line, e.g. "마케팅팀장" */
  title?: string
  /** a profile picture in assets/ (square PNG, JPEG or WebP, 256 px or more); without one the app shows initials.
   * Swap a photo by replacing that file: nothing else changes */
  avatar?: Asset
  /** someone outside the team (e.g. Chris at the agency): not in the people list or rooms */
  outside?: true
  /** their organisation */
  org?: string
  /** v2: shown online (a presence dot) from the start; default: online */
  online?: boolean
}

export interface DemoGroup {
  id: Id
  /** e.g. "마케팅"; the group's folder is groups/<name>/ */
  name: string
  members: Id[]
}

export interface DemoRoom {
  id: Id
  /** team: a group's room (name from the group); dm: two people; group: a named group chat; all: everyone */
  kind: 'team' | 'dm' | 'group' | 'all'
  /** a team room's group */
  group?: Id
  /** a group chat's name (team rooms take the group's name, DMs the other person's) */
  name?: string
  /** who is in it; the visitor must be one of them */
  members: Id[]
  /** what was said before the visitor arrived, oldest first */
  messages?: DemoRoomMessage[]
}

export interface DemoRoomMessage {
  from: Id
  text: string
  /** files attached to the message (paths of `files`) */
  files?: string[]
  /** how long ago it was sent (default: spaced a few minutes apart before the start) */
  minutesAgo?: number
}

export interface DemoProject {
  id: Id
  /** the project's name; its folder is projects/<name>/ */
  name: string
  description?: string
  members: Id[]
  /** earlier chats in the project (e.g. Leo's banner chat), shown in the project's chat list */
  chats?: DemoPastChat[]
}

export interface DemoPastChat {
  id: Id
  title: string
  /** who asked */
  by: Id
  /** question and answer pairs, oldest first */
  turns: { ask: string; answer: string; files?: string[] }[]
}

export interface DemoFile {
  /** the team path, e.g. "projects/겨울 캠페인/banner-v1.png" */
  path: string
  /** its content: a file in assets/, or a text */
  asset?: Asset
  text?: string
  /** follow the visitor's choice: when one of these answers finished, its asset is used instead of `asset` (the
   * latest one wins), e.g. the CEO's final file is the banner the visitor made: { 'banner-a': 'banner-a.png',
   * 'banner-b': 'banner-b.png' } */
  pick?: Record<Id, Asset>
}

/** Where an answer is given: Home's new chat, a project's chat, the ✦ side chat beside a room, or anywhere. */
export type DemoPlace = 'home' | { project: Id } | { side: Id } | 'any'

export interface DemoAnswer {
  id: Id
  /** the visitor's message that gets this answer (the button sends exactly this) */
  prompt: string
  /** a shorter button label for the prompt (default: the prompt) */
  label?: string
  /** where this prompt is offered and answered (default 'any') */
  where?: DemoPlace
  /** the work shown before the text (tool calls), in order */
  steps?: DemoStep[]
  /** the answer, streamed in like a real one */
  text: string
  /** files the answer makes (saved to the team folder when it finishes, linked under the answer); a picture shows in
   * the answer when the text links it with `![](...)` and `{{file:<path>}}` */
  files?: DemoFile[]
  /** a card after the text with buttons; the chosen option's reply goes on in the same answer */
  ask?: DemoAsk
  /** team files the answer read: the app's own "sources" under the answer (paths of `files`). Pictures the answer made
   * show in its text, as a real answer shows them: `![label]({{file:<path>}})` */
  sources?: string[]
}

export interface DemoReply {
  steps?: DemoStep[]
  text: string
  files?: DemoFile[]
  /** another card after this reply (e.g. "Send it?" after a draft) */
  ask?: DemoAsk
}

export interface DemoAsk {
  question: string
  options: { label: string; reply: DemoReply }[]
}

export interface DemoStep {
  /** what the step says, e.g. "Higgsfield · 배경 이미지 만들기" or "파일 읽기 · projects/겨울 캠페인/brief.md" */
  label: string
  /** the tool's kind for its icon: read, write, glob, grep, web_search, or a connection's name (default: a tool) */
  tool?: string
  /** how long it runs (default 700 ms) */
  ms?: number
}

/** Something that happened in the story. */
export type DemoTrigger =
  /** the demo started (Home is on screen) */
  | { start: true }
  /** an answer finished streaming (its cards answered too, when it has some); a list: any of them */
  | { answer: Id | Id[] }
  /** the visitor sent an answer to a room with "대화방에 보내기" */
  | { shared: Id }
  /** an event's message was posted */
  | { event: Id }
  /** the visitor opened a room or a project's chat */
  | { opened: { room: Id } | { project: Id } }

export interface DemoEvent {
  id: Id
  /** when it is sent */
  after: DemoTrigger
  /** wait this long after the trigger (default 1500 ms) */
  delayMs?: number
  /** where: a room id */
  room: Id
  from: Id
  /** the message; v2: none for an event that only reacts (see `reactions`) */
  text?: string
  /** v2: how long "<name> is typing…" shows before the message (default 1100 ms; 0: none) */
  typingMs?: number
  /** v2: emoji reactions that pile up, one by one: on this event's message, or with `on: 'visitor'` on the visitor's
   * latest message in the room (e.g. on Mina's post). `afterMs`: after the previous one (default 2500) */
  reactions?: { from: Id; emoji: string; afterMs?: number }[]
  /** the message the reactions go on: this event's (default), the visitor's latest in the room, or another event's */
  on?: 'self' | 'visitor' | { event: Id }
  /** sent only once this has happened too (checked when `after` happens; an `opened` trigger counts every visit, so
   * "the visitor opened #Everyone after the shoutout" is `after: { opened: { room } }, requires: { event }`) */
  requires?: DemoTrigger
  /** files attached (paths of `files`, or new ones listed in `newFiles`) */
  files?: string[]
  /** files this message brings that did not exist before (e.g. the CEO's final file) */
  newFiles?: DemoFile[]
}

/** A place in the app the guide (or a toast) takes the visitor to. */
export type DemoGo = 'home' | { room: Id } | { project: Id } | { side: Id }

export interface DemoGuideStep {
  id: Id
  /** the line, e.g. "Next: open Sara's message →" */
  text: string
  /** v2: the line while the visitor is somewhere else than `go`, e.g. "Sara is waiting in your DMs →" (default: text) */
  away?: string
  /** where the line takes the visitor when they click it (brings them back if they wandered off) */
  go: DemoGo
  /** the app's control to ring there, as a CSS selector (copy the ones in the example; most are data-testid). Exactly one
   * thing is ringed at a time. Without one, the demo rings the way there when the visitor is elsewhere (the room's or
   * project's link, the ✦ button of a side chat) */
  highlight?: string
  /** answer ids offered as buttons in the guide line (e.g. the two banner prompts); the guide line's own click sends
   * the first */
  suggest?: Id[]
  /** the step is over when this happens; the next one shows */
  until: DemoTrigger
  /** shown from this trigger on (default: when the step before it is over) */
  after?: DemoTrigger
}

/** The end: the guide line's last state (no card over the app): the title, the real time since the first question and
 * the contrast, and the sign-up link. */
export interface DemoEnd {
  /** shown when this happens */
  after: DemoTrigger
  /** delay after the trigger (default 2500 ms) */
  delayMs?: number
  /** e.g. "Mina's first day: launch campaign shipped in {time}" ({time}: the visitor's real time; without it the
   * time follows the title) */
  title: string
  /** what this usually takes, after the line in brackets, e.g. "usually ~2 days" */
  contrast?: string
  /** the sign-up link, opened in a new tab (the build's VITE_DEMO_SIGNUP_URL replaces `url` when set) */
  signup: { label: string; url: string }
}
