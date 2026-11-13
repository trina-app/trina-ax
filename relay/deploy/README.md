# Relay deployment reference (operator guide)

Historical deployment design (control-plane spec 3.6.1, decisions D17–D21), not a public service-availability or recovery-time promise. Substitute your own domain, accounts and storage configuration. One Linux VM (Lightsail Seoul 4 GB,
Ubuntu 24.04), Node 26 LTS, two systemd instances `mycel-relay@a` / `@b` for zero-downtime deploys, the registry in
SQLite replicated to R2 by Litestream, TLS terminated by the relay itself with a Cloudflare Origin CA certificate and
Cloudflare Authenticated Origin Pulls (our own zone certificate), the firewall open on 443 to Cloudflare only.

| File | What |
|---|---|
| `mycel-relay@.service` | the relay unit (template; instances `a`, `b`) |
| `relay.env.example`, `instance-{a,b}.env` | settings (`/etc/mycel-relay/`) |
| `operator-keys.example.json` | operator API keys (`/etc/mycel-relay/operator-keys.json`): the control plane's and the break-glass key |
| `setup-host.sh` | one-time host setup (packages, Node, Litestream, account, folders, units, firewall) |
| `install-node.sh` | Node 26.12.1, official tarball, sha256 pinned |
| `relay-deploy.sh` | a/b deploy of a bundle from `scripts/build-relay.ts`; `--rollback` |
| `nftables.conf`, `cf-ips-refresh.{sh,service,timer}` | firewall; weekly refresh of Cloudflare's ranges |
| `litestream.yml` | continuous registry replication to `teamax-ops/relay/litestream` |
| `registry-backup.{sh,service,timer}` | daily `VACUUM INTO` → age (organisation recovery key) → `teamax-ops/relay/daily/` |
| `mycel-relay-cli` | the relay's operator commands on the host (break glass) |
| `relay-checkin.sh` | Sentry cron check-ins around the timers' jobs (`/usr/local/sbin/relay-checkin`) |
| `litestream-check.{sh,service,timer}` | every 15 min: is Litestream running and is the replica keeping up |

## Owner steps (once)

1. **VM**: Lightsail Seoul, 4 GB, Ubuntu 24.04, a static IP. Lightsail firewall: 443 only (Tailscale needs no inbound).
2. **Tailscale**: install, join with tag `tag:relay`; ACL: `tag:cp` → `tag:relay:8090`, `group:ops` → `tag:relay:22`.
   Note the relay's tailnet IP for `RELAY_PRIVATE_LISTEN` in `/etc/mycel-relay/relay.env`.
3. **Build and copy a bundle**: on a dev machine `bun scripts/build-relay.ts` → `dist/relay/teamax-relay-<v>.tar.zst`
   (+ `.sha256`); copy both to the VM, unpack once (`zstd -dc … | tar -x`) and run `sudo ./teamax-relay-<v>/deploy/setup-host.sh`.
4. **Origin certificate** (Cloudflare → SSL/TLS → Origin Server → Create certificate, ECC, 15 years, hosts
   `*.example.com`, `example.com`): save as `/etc/mycel-relay/credentials/origin.pem` and `origin.key` (root 0600).
5. **Authenticated Origin Pulls with our own certificate** (zone level, not the shared global certificate):
   ```sh
   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 5475 \
     -keyout aop-ca.key -out aop-ca.pem -subj "/CN=Trina AX AOP CA" -addext basicConstraints=critical,CA:TRUE
   openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -keyout aop.key -out aop.csr -subj "/CN=cloudflare-aop"
   openssl x509 -req -sha256 -days 5475 -in aop.csr -CA aop-ca.pem -CAkey aop-ca.key -CAcreateserial -out aop.pem \
     -extfile <(printf 'extendedKeyUsage=clientAuth')
   ```
   Upload `aop.pem` + `aop.key` to Cloudflare (SSL/TLS → Origin Server → Authenticated Origin Pulls → zone-level
   certificate, API `POST /zones/{zone}/origin_tls_client_auth`), turn AOP on for the zone, copy `aop-ca.pem` to
   `/etc/mycel-relay/credentials/aop-ca.pem`. Keep `aop-ca.key` offline (it is only needed to issue the next one).
6. **Operator keys**: the control plane's `relay_ops_key` public key (base64 SPKI Ed25519) as keyId `cp`, the
   operators' break-glass key as `ops-break-glass`, in `/etc/mycel-relay/operator-keys.json` (root:mycel-relay 0640).
   Rotation: add the new key first, switch the control plane, then remove the old one (the relay re-reads the file).
7. **R2**: bucket `teamax-ops` (location hint apac), a token for that bucket only →
   `/etc/default/litestream` (`LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`);
   `/etc/mycel-relay/backup.env` with `ORG_RECIPIENT=age1…` (the organisation recovery key's public part) and
   `R2_ACCOUNT_ID`. Lifecycle rule: `relay/daily/` 30 days. `systemctl enable --now litestream`.
8. **DNS / Cloudflare** (zone example.com): `*` A → relay IP (proxied), `relay` A (proxied); SSL/TLS **Full (strict)**;
   Always Use HTTPS; Cache Rule "bypass cache" for `*.example.com` except `updates.` and `www.`; Configuration Rule
   (same hosts) Email Obfuscation off, Rocket Loader off; WebSockets on.
9. **First deploy**: `sudo relay-deploy /path/teamax-relay-<v>.tar.zst` → `https://relay.example.com/healthz` 200.
   Check that the origin refuses a direct TLS connection: `curl -vk https://<static ip>/healthz` must fail the handshake.

## Error reports and check-ins

Off until you set a key. Put the Sentry project's DSN in `/etc/mycel-relay/relay.env`:

```sh
RELAY_SENTRY_DSN=https://<public key>@<host>/<project id>   # empty (the default): nothing is sent
RELAY_SENTRY_ENV=production                                  # optional, the environment name
```

The relay reads it when it starts, so the next `relay-deploy` picks it up; the timers read the file on every run. A host set up before this change needs `setup-host.sh` from the new bundle once: it installs the check-in
wrapper, the Litestream check and its timer, and the unit that tags reports with the instance.

What is sent:

- **Errors** from the relay (`shared/src/sentry-report.ts`, the same rules as the team server's opt-in reports, docs/DECISIONS.md
  "Error reports to Sentry"): a crash (uncaught exception, unhandled rejection; the relay still exits and systemd
  restarts it), a start that failed, and every error line of the relay log. A report holds the error type, the log
  event name (`request_failed`, `ops_keys_unusable`, …), the error message with addresses, paths, host names, emails,
  secrets, long ids and non-English text taken out, stack frames (the last two parts of a file name, function, line),
  and the tags `release` (`relay@<version>`), `environment` and `instance` (`a` or `b`). At most one copy of the same
  error a minute and 30 reports a minute.
- **Check-ins** (Sentry Crons; the monitor is created by its first check-in). Each run sends `in_progress`, then `ok` or
  `error`, with a random check-in id, the environment and the schedule. A check-in that cannot be sent never changes
  the job's result.

  | Monitor slug | Job | Schedule (UTC) |
  |---|---|---|
  | `relay-registry-backup` | `registry-backup.service` | daily 18:40, 30 min margin |
  | `relay-cf-ips-refresh` | `cf-ips-refresh.service` | Mondays 03:17, 45 min margin (the timer waits up to 30 min) |
  | `relay-litestream` | `litestream-check.service` | every 15 min: error when `litestream` is not active, its replica cannot be listed, or the registry changed more than 15 min after the newest replica file |

Never sent: client addresses, request paths, host names, headers, cookies, team names or ids, team keys, operator keys,
registry contents, job output. The relay log never holds the first four either (`relay/src/log.ts`).

## Deploy, roll back

```sh
sudo relay-deploy "/path/to/teamax-relay-VERSION.tar.zst" # replace VERSION   # starts the idle instance, checks it, stops the old one
sudo relay-deploy --rollback                          # the previous release, same a/b way
```

## Restore (target timing requires a deployment-specific drill)

New VM from the Lightsail snapshot (or `setup-host.sh` on a fresh one) → `litestream restore -o
/var/lib/mycel-relay/registry.db /var/lib/mycel-relay/registry.db` (as root, then `chown mycel-relay`) → credentials and
`/etc/mycel-relay/*` from the secrets store → `relay-deploy <bundle>` → Cloudflare DNS `relay` and `*` A records to the
new static IP. Team servers reconnect by themselves (back-off at most 30 s).
