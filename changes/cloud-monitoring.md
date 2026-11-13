- Operators of the relay and the push gateway can get error reports and cron check-ins in their own Sentry project:
  set `RELAY_SENTRY_DSN` or `PUSH_GATEWAY_SENTRY_DSN` on the host. Nothing is sent without it. The push gateway reports
  when Apple or Google refuse its own credentials, not when one phone's token is dead. The relay's nightly backup,
  firewall-range refresh and a new 15-minute Litestream check report each run as `relay-registry-backup`,
  `relay-cf-ips-refresh` and `relay-litestream`.
