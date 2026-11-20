// The shapes of a demo content's fake Gmail and Google Drive (free-roam demo): gmail.json and drive.json in the folder
// the demo file's `fakes.content` names. The server's demo fakes read them (server/src/demo/fakes/gmail.ts GmailContent,
// drive.ts DriveContent: theirs win where these differ); the demo scripts check a content folder with these
// (scripts/demo/company/fakes.ts). from/to/cc are "Name <address>"; a time is ISO or "-<n>d" / "-<n>h" / "-<n>m"
// before the instance started; labels are Gmail's (INBOX, SENT, UNREAD …); attachments go by file name.
import { z } from 'zod'

const Person = z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320) }).strict()
const MailId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export const RELATIVE_TIME = /^-(\d{1,4})([dhm])$/
const When = z.string().min(1).max(64).refine((d) => RELATIVE_TIME.test(d) || !Number.isNaN(Date.parse(d)), 'an ISO time or -<n>d / -<n>h / -<n>m')
export const FakeGmail = z.object({
  me: Person,
  messages: z.array(z.object({
    id: MailId.optional(), threadId: MailId.optional(),
    from: z.string().min(1).max(400), to: z.string().min(1).max(4000), cc: z.string().max(4000).optional(),
    subject: z.string().max(1000), date: When, body: z.string().max(200_000),
    labels: z.array(z.string().max(100)).max(50).optional(),
    attachments: z.array(z.string().max(300)).max(50).optional(),
  }).strict()).max(2000),
}).strict()
export type FakeGmail = z.infer<typeof FakeGmail>
const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)
export const FakeDrive = z.object({
  me: Person,
  files: z.array(z.object({
    id: FileId, name: z.string().min(1).max(300), mimeType: z.string().max(256).optional(), parent: FileId.optional(),
    text: z.string().max(1_000_000).optional(), modifiedTime: When.optional(),
  }).strict()).max(5000),
}).strict()
export type FakeDrive = z.infer<typeof FakeDrive>
