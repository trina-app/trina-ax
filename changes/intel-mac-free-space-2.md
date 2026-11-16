- The free-space check on an Intel Mac no longer waits for `df`: it runs in the background, so a disk check never
  holds up the server, even when a network drive stops answering. On a Linux server where only one of the two
  disks can be read, Admin › System still shows the other disk's levels.
