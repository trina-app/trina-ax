# The AI gives times in the person's device time zone; the team zone stays the setting

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/ai-times-viewer-zone (QA TC-4549, related row TC-2909; manual MAN-023, MAN-028, MAN-029, MAN-030 on qa.trina.app, dev build of
  2026-11-17)

- **Ask:** every time in an AI answer was two hours later than the room showed. The AI said 11:08 where the room showed
  9:08 AM, and "7:10 PM" for a quote the room showed at 5:10 PM. The team on qa is set to Asia/Seoul, and the tester's
  browser was in Jakarta (UTC+7).
- **Cause:** the room screen shows times in the browser's zone. The AI got only the team zone: the time line of its
  instructions (`chat/prompt.ts` `timeLine`) said "give it in Asia/Seoul", and the room tools printed message times in
  the team zone (`rooms/reader.ts` `localTime` with `rt.timeZone`, also in `chat/looking-at.ts` and the save card's
  file line in `chat/turn.ts`). Nothing was wrong in the conversion itself. The two screens used different zones.
- **Rule:**
  - The web app sends the browser's zone with each turn: `timeZone` on send, edit and regenerate
    (`shared/src/api/chats.ts` `TurnTimeZone`, at most 64 characters). The server keeps it only when it is an IANA name
    its runtime knows (`routes/chats.ts` `turnZone`). An unknown name is dropped, not refused, because an older
    browser's zone list may differ from the server's. The zone is kept on the turn (`TurnSpec.timeZone`).
  - The time line still says `<team zone> is the team time zone, read from the team settings` (#1139, TC-3700,
    [20261116-time-zone-team-setting.md](20261116-time-zone-team-setting.md)), so "is our team zone Seoul?" is still
    answered from the setting. When the device zone differs, "Now:" is given in the device zone, and the line adds
    "The user's device is set to <zone>, and the app shows them every time in <zone>." The AI is told to give every
    time in that zone.
  - The tools print the times in the zone the AI should say (`system/time-zone.ts` `shownTimeZone`: the device's zone,
    else the team's), so the model never converts room times itself. Converting is what had gone wrong before (QA TC-060,
    a381f256b: "00:39 WIB" for a file sent at 17:39). Each result names its zone: "Times are in Asia/Jakarta." replaces "Times are
    in the team's time zone." The tools are rooms, room_read, room_file, save_room_file and looking_at. The Trina AX
    MCP for other AI apps uses the same reader and names the team zone, which is the zone it prints. A time the AI types
    for a room search (since or until) is read in that same zone.
  - A turn with no person's zone keeps the team zone, exactly as before. This covers scheduled runs, Slack, skill
    sharing, onboarding drafts, older apps, and a queued turn picked up again after a restart.
  - Results that are about the team's calendar keep the team zone and name it. They are left as they were: schedule
    times (schedules run in the team zone), the trash "restore until" day, and the Shared with me day.
- **Why not let the model convert:** the line already told it what zone the room times were in, and it repeated them.
  A time printed in the zone it will be said in leaves nothing to convert.
- **Prompt caching:** the time line is near the end of the instructions already, and it changes every minute. The text
  before it does not change. A device zone adds about 25 tokens to that line.
- **Not done:** in a shared chat, the answer stays in the asker's zone. Other people may read it in another zone, and
  a written answer cannot follow each reader. `post_to_room`'s room list still prints the team zone without naming it.
  That file belongs to another change in progress and is left alone.
- Tests: `tests/unit/b-review.test.ts` (TC-4549: the time line with team Asia/Seoul and device Asia/Jakarta, and
  absent, same or unknown zones); `tests/unit/b-ai-times-viewer-zone.test.ts` (the route takes, checks and passes the
  zone on send, edit and regenerate; room_read prints Jakarta times and says so; an unknown zone falls back to the team
  zone; a name longer than 64 characters is refused); `tests/unit/b-chat-rooms.test.ts` (the room file's time names its
  zone). Real AI: `tests/ai-scenarios/cases.yaml` ROOM-02.viewer-zone (the new `timeZone` case field), with ADM-05.ask
  still answered from the setting.
- Version impact: patch (an optional request field, no migration).
