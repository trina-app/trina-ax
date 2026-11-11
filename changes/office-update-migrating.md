- The office Mac's automatic update no longer rolls back when the new version has to update a large database first: it
  waits while the server says it is updating its database (up to an hour, as a Linux server does), and `teamax status`
  says so. Meanwhile desks on the office address (`https://<Mac IP>:8443`) get "connection refused"; docs/OFFICE.md says
  what to expect.
- `mycel-ctl update` waits for a large database update as long as the server's bootstrap does (its `--migrate-timeout`
  in the server unit), not a fixed hour.
