/** Chat attachments of a person live under users/<id>/<this>/ (uploads/attachments.ts). Its own small module: places
 * that only need the name (files/share-places.ts) do not load the upload code. */
export const ATTACHMENTS_DIR = '.attachments'
