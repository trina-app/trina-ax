- The relay now refuses a signed operator or team call that is sent a second time, even when its signature is written
  differently. Before, a copied team call (status, heartbeat, rename, key change, release) could be sent again within a
  minute, and an operator call could be sent again with its signature re-spelled.
- The relay refuses an operator key list that names the same public key twice (under two key ids), so a copied operator
  call cannot be sent again under the other id. A list like that now stops all operator calls until it is fixed, so
  check operator-keys.json before updating a relay.
