-- min_compatible_reader: 1
-- Component A, security review round 4: the networks each person signed in from. While failed sign-ins from
-- elsewhere (the internet) hold their account limit, a correct password from a network they signed in from before
-- still signs them in (auth/accounts.ts login). net = the client IP as the rate limiter counts it (an IPv4 address,
-- an IPv6 /64). Rows older than 90 days are dropped; at most 20 per person. Additive only.
CREATE TABLE login_nets (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  net TEXT NOT NULL,
  last_at INTEGER NOT NULL,       -- unix ms
  PRIMARY KEY (user_id, net)
);
