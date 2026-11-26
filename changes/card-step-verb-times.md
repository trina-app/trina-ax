- A connected app's step now names the item it acts on, not the kind of action: a Google Calendar event reads
  `Google Calendar · Manage an event · "Team lunch"`, not `· "create"`. An argument that only picks an action, a mode
  or a type is never shown there, for every connection.
- Dates and times on a confirmation card read as dates in your app language ("Fri, Nov 27, 2026, 3:00 PM"), not as
  `2026-11-27T15:00:00`. The time is shown as written, with its offset when it has one; the exact call is unchanged.
