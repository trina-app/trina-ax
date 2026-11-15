- **AI app sign-in page:** a request that expired, or that another login session already opened, now says "This
  request expired or was opened in another login session. Connect again from the app." instead of "Not found or no
  access.", and the old request with Allow and Deny is hidden, also when it expires while the page is open.
- **Settings › AI apps:** while the connection for AI apps is off on the server, older connections no longer say
  "Connect again to use conversations." (it cannot work while it is off); Disconnect stays.
- **Connect dialog:** it waits for the app it is about. When another app connects meanwhile (Claude while the Claude
  Code steps are open), it says so in its own line and keeps waiting instead of "Connected: Claude".
