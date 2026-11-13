- Office mode: new optional Tailscale address. Run `~/TeamAX/teamax tailscale-address on` on the office Mac, and the
  devices on the same tailnet open `https://<machine>.<tailnet>.ts.net:<port>` from anywhere (a phone on mobile data
  too). The certificate is the tailnet's Let's Encrypt certificate, so there is no warning and no office certificate to
  install. The first-run setup is refused on this address. Tailscale renews the certificate, and the server loads the
  new one without a restart. Installs without this option do not change.
