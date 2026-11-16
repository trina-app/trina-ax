- Setup › Team files: the question about making team skills from your forms now reads "When a teammate asks for
  'Order', the AI fills in this form." It read "Make a Order" for a form named "Order form". The Spanish sentence no
  longer puts "un" before the form's name, and a form named "Plantilla de pedido" keeps its whole name.
- Connected apps: after you choose Cancel or Deny on a service's sign-in page, the app now says "The sign-in was stopped
  at the service. To connect, sign in again and allow it to connect." A connection still waiting for its first sign-in
  says "The sign-in was not finished, so this is not connected yet. Choose Sign in to try again." Both said the service had not
  allowed access, or had not accepted its key or sign-in. An error from the service itself now reads "The service did
  not finish the sign-in."
- Office Mac: when the server has not answered by the end of the installer's wait, `office-install.sh` now says "the
  server has not answered yet. It may still be starting", names `teamax status` to check, and ends with exit code 3. It
  said "the server did not start" for a server that was up a minute later. Exit code 1 still means it did not start,
  and automatic updates work as before.
- Office Mac: `teamax status`, `teamax update status` and Admin › System no longer show an old failed update once a
  newer version is installed. A failed update to 0.5.7 stayed as the last result under a running 0.5.8.
