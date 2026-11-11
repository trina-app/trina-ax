// The file list's choices that the owner may still change (docs/AGENTS/plan/20261111-0630-file-list.md "Owner
// questions"), and its limits. One place, so flipping one is a one-line change.

/** (a) Personal folders users/<id> are read and listed (for their person only). Off for now: only shared, project,
 * group, connected and other team folders. */
export const READ_PERSONAL = false

/** (b) A team whose only AI is Codex: images and scans are sent to it too. Off: text documents only (the launcher writes
 * text files only, and Codex takes images as files). */
export const CODEX_IMAGES = false

/** (c) Turning the switch off deletes the stored lines (the sidecar's descriptions); on again reads the files again over
 * the next nights. */
export const FORGET_ON_OFF = true

/** A camera photo (a JPEG with a camera in its EXIF, or a HEIC) gets a line from its metadata only, unless the server's
 * OCR finds text in it (a photo of a document). Saves most of a phone's photo folder from the model. */
export const CAMERA_PHOTOS_META = true

/** Per run (a night, or an admin's Run now): at most this many files read by the model and this many tokens (input
 * and output), so a subscription's 5-hour and weekly limits are left to people in the morning. The rest waits for the
 * next night. A host may set others in server.json (fileList.maxFilesPerRun, fileList.maxTokensPerRun). */
export const RUN_FILES = 1500
export const RUN_TOKENS = 1_500_000
