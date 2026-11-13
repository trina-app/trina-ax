- **Connectors: services that let only apps they approved sign in now say so.** Figma, Square and Intercom said "Try an
  API key instead", which those services do not offer, and Canva opened an "Invalid redirect URI" page and then waited
  for a sign-in forever. Now the connector and the chat card say the service has not approved this app yet. Where the
  service says it can check an app another way (Canva, Vercel, Railway and Indeed do), Trina tries that first, so these
  may connect.
- A sign-in that failed or was closed no longer counts toward the 20 personal connections, and Connect again for the
  same service picks up the one that is waiting. Before, a few failed tries could stop someone adding anything.
- Netlify connects at its documented address, `mcp.netlify.com`. Connections saved at the old address still count as
  Netlify.
