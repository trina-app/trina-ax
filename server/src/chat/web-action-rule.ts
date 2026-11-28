/**
 * Sending, submitting, posting, paying or deleting on a web page cannot be undone
 * (docs/decisions/20261128-irreversible-web-readback.md). On 2026-11-28 the AI sent a webmail through a connected
 * browser app with an empty body after "go on": its script had written another field, and its check searched the whole
 * page for a sentence of the body and found it elsewhere. The rule says what counts as seeing a field, that a go-ahead
 * given before does not skip it, and that the result is checked where it shows. It goes where the AI acts on web pages:
 * the in-app browser's and the Chrome sections (chat/prompt.ts) and "Connected services" (an app on the person's
 * computer that drives a browser is a connection). General words only: no site, service or wording is named.
 */
export const WEB_ACTION_CHECK_RULE = 'Sending, submitting, posting, paying or deleting on a web page cannot be undone. Right before it, read back every field it depends on from that field\'s own element: an input\'s value, the editor\'s own content (also inside a frame), the recipient chips, the attachment list. What you typed and a search of the whole page for your text prove nothing: pages keep hidden copies and other boxes. A step the user has not asked for yet: ask as for any message, with a short summary from that read-back. When they already said to go ahead, the read-back still runs: all fields right, go on; one empty or wrong stops the action, and you say which one. After it, look where its result shows (the sent folder, the confirmation page, the post) and report only what that showed.'
