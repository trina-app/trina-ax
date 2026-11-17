// Where a file sent in a room was saved in the team folder (room_file_saves, migration 415): written by a person's "Save
// to team folder" (rooms/save-to-team.ts) and by the AI's save_room_file (chat/room-tools.ts). A row only says where to
// look; every read checks that the copy is still there with the same bytes and that the viewer may open it.
import type { AppContext } from '../context'
import { nowIso } from '../db'

export function recordRoomFileSave(ctx: Pick<AppContext, 'db'>, fileId: string, rel: string, sha256: string, size: number): void {
  ctx.db.query('INSERT INTO room_file_saves (file_id, path, sha256, size, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(file_id, path) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, saved_at = excluded.saved_at')
    .run(fileId, rel, sha256, size, nowIso())
}
