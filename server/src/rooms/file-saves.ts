// Where a file sent in a room was saved in the team folder (room_file_saves, migration 415): written by a person's "Save
// to team folder" (rooms/save-to-team.ts) and by the AI's save_room_file (chat/room-tools.ts). A row only says where to
// look; every read checks that the copy is still there with the same bytes and that the viewer may open it.
import type { AppContext } from '../context'
import { nowIso } from '../db'

/** `seen`: the copy's identity on disk now (statKey), when the caller just placed or hashed it */
export function recordRoomFileSave(ctx: Pick<AppContext, 'db'>, fileId: string, rel: string, sha256: string, size: number, seen: string | null = null): void {
  ctx.db.query('INSERT INTO room_file_saves (file_id, path, sha256, size, seen, saved_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(file_id, path) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, seen = excluded.seen, saved_at = excluded.saved_at')
    .run(fileId, rel, sha256, size, seen, nowIso())
}

/** A file's identity on disk: the same inode, size and modification time mean the same bytes as when it was hashed. */
export const statKey = (st: { ino: number | bigint; size: number | bigint; mtimeMs: number | bigint }) => `${st.ino}:${st.size}:${st.mtimeMs}`
