# mailbox-ses

The room email mailbox on AWS (plan [20261123-0421-room-email](../docs/AGENTS/plan/20261123-0421-room-email.md),
section "Change 2026-11-23"). Contract: [shared/src/cloud-protocol/mail-in.ts](../shared/src/cloud-protocol/mail-in.ts).
Ops steps: [docs/runbooks/room-email-mailbox.md](../docs/runbooks/room-email-mailbox.md).

It uses the mailbox code of [mailbox/](../mailbox/README.md) (gateway, API, store, `node:crypto` seal) as it is, and
adds only the AWS parts:

| file | what it does |
|---|---|
| `src/aws.ts` | Signature Version 4 over `fetch` (DynamoDB, SSM, S3), credentials from the Lambda environment; no AWS SDK |
| `src/dynamo-kv.ts` | the store's key-value interface in one DynamoDB table (`pk`, `sk`, value `v`, TTL `x`) |
| `src/handlers.ts` | the SES event (each recipient once, then the S3 object deleted), the function URL event, the held poll that looks at the table, the registry lookup with its cache |
| `src/lambda.ts` | the two Lambda entries: `index.gateway` (SES rule action) and `index.api` (function URL, response stream) |
| `template.yaml` | CloudFormation: S3 bucket, DynamoDB table, two functions, roles, log groups (14 days), function URL, SES rule set and rule |
| `deploy.sh` | build, upload the bundle, deploy the stack (tag `purpose=room-email`), activate the rule set |

```
MX in.trina.app ──> SES (us-east-1) ── rule "room-email-in" ──> S3 raw/<messageId>  (SSE-S3, 1-day lifecycle)
                                                         └──> Lambda room-email-gateway ──> DynamoDB room-email-mailbox
team server ── signed POST /api/mail-in/v1/* ──> Lambda URL room-email-api ──┘      └──> POST cp.trina.app/internal/mail-in/team
```

## Differences from the Cloudflare reference

- **No SMTP refusal.** SES accepts every address of the domain. An unknown, removed or replaced address, a mail over
  10 MiB, a full queue and a limit **drop** the mail and log `mail_refused` with the reason. No bounce is sent.
- A mail SES marks as a virus is dropped. A stored mail with many recipients is handled once per recipient (marks
  `d:<messageId>:<hash>`, kept 2 days), so a retried invocation does not queue a copy.
- The raw mail is deleted from S3 as soon as it is sealed. The lifecycle rule is a backstop.
- The held poll looks at the table every 2 seconds (the gateway is another function). The call limit is per Lambda
  instance.
- `auth` comes from SES's own `Authentication-Results: amazonses.com` header.

## Run and test

```sh
bun test tests/unit/mailbox-ses.test.ts tests/unit/mailbox-gateway.test.ts tests/unit/mailbox-api.test.ts
bunx tsc -p mailbox-ses/tsconfig.json --noEmit
```

## First deploy

1. Make the registry token (also used by trina-cloud, `docs/runbooks/room-email-lookup.md`), in a 0600 file:
   `umask 077; openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > token.txt`
2. Put it in SSM from the file (never as a command argument):
   `aws ssm put-parameter --name /room-email/cp-lookup-token --type SecureString --value file://token.txt --tags Key=purpose,Value=room-email`
3. `AWS_PROFILE=engine-trina mailbox-ses/deploy.sh`
4. Verify the domain in SES (DKIM CNAMEs) and add the DNS records: runbook steps 2 and 3.

To update the code later: run `deploy.sh` again.
