// Guests and access changes (docs/DECISIONS.md "Guests: only what they were invited to"): after every access change
// (a project's people saved, someone leaving a project, Admin › Folder permissions, groups), a guest who is no longer in
// their one place is switched off (admin/guests.ts disablePlacelessGuests). Registered here, away from admin/folders.ts,
// so folders does not import admin/users (a cycle). Imported for its effect by routes/chats.ts.
import { onAccessChange } from './folders'
import { disablePlacelessGuests } from './guests'

export const GUEST_ACCESS_HOOK = (ctx: Parameters<typeof disablePlacelessGuests>[0], actor: string | null): void => { disablePlacelessGuests(ctx, actor) }
onAccessChange(GUEST_ACCESS_HOOK)
