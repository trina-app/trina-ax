// A person's profile photo (Settings › Profile; docs/DECISIONS.md "프로필과 사람 목록"). Pure rules shared by the server
// (the check of an upload) and the web app (the size the browser cuts the photo to before it sends it).
//
// The web app crops the picked photo to a square and scales it to AVATAR_PX in a canvas, which also leaves out the
// camera's metadata. The server does not trust that: it takes only PNG, JPEG or WebP (never SVG), requires a square
// of 64–512 pixels and at most 256 KiB, and cuts out every metadata block itself (server/src/auth/avatar.ts).
export const AVATAR_PX = 256
export const AVATAR_MIN_PX = 64
export const AVATAR_MAX_PX = 512
export const AVATAR_MAX_BYTES = 256 * 1024
/** what a person may put on their profile line, in characters */
export const PROFILE_TITLE_MAX = 60
export const PROFILE_STATUS_MAX = 80
/** the address of a photo at a version (the long-cached form) */
export const avatarUrl = (id: string, version: number) => `/api/people/${encodeURIComponent(id)}/avatar?v=${version}`
