# menubar

The menubar app for the server Mac (its name comes from shared/src/product.ts) (component G, design tab 6 "상태 읽기"). It shows whether the server is
on, the remote-access state (including "replaced by another instance"), the queue and problems, and opens the web
screen and the logs folder. It polls `GET /api/health` every minute (and when the menu opens) and reads
`<base>/status/status.json`, which the server rewrites every 30 s (`StatusFile` in `shared/src/install.ts`; the Swift
copy is in `Sources/StatusModel.swift` — keep the field names in sync).

```sh
menubar/build.sh                  # menubar/build/<product name>.app (unsigned)
menubar/build.sh --test           # compile and run the status-model tests (Tests/main.swift)
menubar/build.sh --id mycel-test  # an app that watches a test install (/Library/Application Support/mycel-test)
```

Swift command line tools only (no Xcode project). Developer ID signing needs the owner's Apple certificate. The
setup assistant, the AI-subscription connection and the admin-password actions (firewall repair, uninstall) are not
in the menubar app yet.
