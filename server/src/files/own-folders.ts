// The folders right under users/<id>/ that the server names itself (tools/save-url.ts, chat/room-tools.ts, generated
// video, exports, personal projects). One list, read by the two places that must agree on it: the chat turn (their
// names carry nobody's words, chat/turn.ts noteOwnNames) and folder sharing (none of them is ever shared,
// files/share-places.ts). A new server-named folder under users/<id>/ is added HERE, never retyped.
export const SERVER_OWN_FOLDERS: ReadonlySet<string> = new Set(['downloads', 'images', 'videos', 'exports', 'projects'])
