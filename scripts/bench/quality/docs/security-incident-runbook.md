# Security incident runbook

Who does what when a security incident is suspected. Fictional company, Acme Corp.

## Severity levels
| Level | Example | First response | Who is paged |
|---|---|---|---|
| SEV1 | Customer data exposed, production down | 15 minutes | On-call engineer, CTO, CEO |
| SEV2 | Single customer affected, suspicious admin login | 1 hour | On-call engineer, security lead |
| SEV3 | Phishing email reported, minor policy breach | next business day | Security lead |

## Steps
1. Open an incident channel named inc-date-short-name and name one incident commander.
2. Contain first: revoke keys, disable accounts, block IP ranges. Do not delete evidence.
3. If personal data may be involved, tell the legal team within 2 hours; the regulator must be notified within 72 hours
   of confirmation.
4. Post a status update every 30 minutes for SEV1 and every 2 hours for SEV2.
5. Write a blameless postmortem within 5 business days and present it at the next engineering all-hands.
