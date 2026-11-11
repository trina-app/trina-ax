- An update no longer fails and rolls back on a server with a large database. While the new version copies and
  updates its database (minutes on several GB), it answers "updating its database" and the update waits for it, up to an
  hour. Retries no longer leave another full-size `pre-migrate-*.db` copy each time.
