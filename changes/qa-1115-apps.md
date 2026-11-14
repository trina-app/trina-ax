- **Apps in rooms**: after **Regenerate**, an app's settings and its row in the list say "Waiting for GitHub to use the
  new Webhook URL. Paste it into GitHub." until the first message arrives on the new URL. Before, they kept showing
  "Last message …" while the service was still sending to the old URL and getting refused. The words name the service
  (GitHub, Stripe …), not the name the app was given.
- When **all of a team's apps together** reach 5,000 messages in a day, the room line, the app's settings and the
  Activity notice now say "Your team's apps reached 5,000 messages today. All apps are paused until …" with the time in
  the team's time zone, and offer no **Resume now** (it could not help before then). Before, they said the one app
  reached 5000 or 500 messages. An app paused by its own daily limit still says 500 (or 1,000 after Resume now), and
  counts show thousands separators.
