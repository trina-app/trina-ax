- On a Mac (and every install that is not a Linux server), the server check no longer calls a large disk read-only
  while it still has more than 10 GB free. Before, a 2 TB disk with 85 GB free showed as almost full and read-only,
  although saving still worked. It now shows as low on space.
