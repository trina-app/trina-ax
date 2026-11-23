# mailbox

Reference code for **email into rooms** (plan
[docs/AGENTS/plan/20261123-0421-room-email.md](../docs/AGENTS/plan/20261123-0421-room-email.md)): the mail gateway
and the mailbox that a team server pulls room mail from. The contract is
[shared/src/cloud-protocol/mail-in.ts](../shared/src/cloud-protocol/mail-in.ts) (MIT).

**It is not deployed from this repository.** No Cloudflare account, domain, DNS record or production service is set
up by this code or its tests. The ops steps are in
[docs/runbooks/room-email-mailbox.md](../docs/runbooks/room-email-mailbox.md).

## What is here

| file | what it does |
|---|---|
| `src/gateway.ts` | one mail: recipient check (550), size (552), queue room (452), limits (451), removes `Authentication-Results` and `ARC-*` headers, seals the mail to the team's key, queues it |
| `src/api.ts` | the team server API: `status`, `key`, `sync`, `poll` (signed with the relay team key; long poll, lease, ack, 24-hour expiry) |
| `src/store.ts` | what is kept: seal keys, address hashes, sealed items, counters, nonces; over a key-value interface (a `Map`, or a Durable Object's storage) |
| `src/crypto.ts` | the crypto interface and its WebCrypto implementation (the Worker) |
| `src/node-crypto.ts` | the same with `node:crypto` (tests and the dev server; Bun's WebCrypto has no X25519) |
| `src/worker.ts` | the Cloudflare entry: the Email handler, the fetch handler and the `Mailbox` Durable Object |
| `src/dev.ts` | a local mailbox in memory on `127.0.0.1` with `POST /dev/send` to "send" a mail |
| `wrangler.example.toml` | placeholders only |

The mailbox never sees an address: a team server sends only `sha256(local part)`. It never keeps a mail in clear:
the gateway seals it before it is stored. Logs carry a hash prefix and a reason only.

## Run and test

```sh
bun test tests/unit/mailbox-gateway.test.ts tests/unit/mailbox-api.test.ts
bunx tsc -p mailbox/tsconfig.json --noEmit
bun mailbox/src/dev.ts --port 19171 --domain mail.localhost
```

With the dev mailbox running, a team server that reads `MYCEL_MAIL_IN_URL=http://127.0.0.1:19171` and `MYCEL_MAIL_IN_DOMAIN=mail.localhost` registers its key
and addresses; then:

```sh
curl -s http://127.0.0.1:19171/dev/send -H 'content-type: application/json' \
  -d '{"to":"<the room address>","from":"shop@example.com","raw":"From: Shop <shop@example.com>\r\nSubject: New order\r\n\r\nOrder 1"}'
```

## Known limits of this reference

- One Durable Object holds all teams. Shard by team when the load asks for it.
- What Email Routing does when the Worker throws (a temporary or a permanent failure for the sender) is not checked
  yet: phase 0 of the plan.
- Whether the Worker sees Cloudflare's own `Authentication-Results` header is not checked yet. When it does not,
  `auth` is `null` (unknown) and nothing uses it.
- The WebCrypto path (X25519 in Workers) has no test here: Bun has no X25519 in WebCrypto. Test it with the Workers
  test runner before the first deploy.
- A team server that stops polling keeps its addresses; its mail expires after 24 hours and is counted.
