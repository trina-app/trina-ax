- Team AX Cloud servers now refuse every inbound connection. The engine firewall (`mycel-ctl firewall apply`) adds an
  input chain with policy drop on a hosted server. It accepts only loopback, replies to the server's own connections,
  the ICMP and IPv6 neighbour messages that the network needs, and DHCP replies. A team server only dials out (relay,
  control plane, ax-link), so nothing changes for the team. Self-installs get no input chain.
- `mycel-enroll` on a hosted server now waits up to 10 minutes for a data disk that is attached after boot (Lightsail
  attaches it after the instance runs). Before, it failed at once with `data_disk_missing`. On EC2 and Proxmox the
  disk is there at once, so nothing waits.
