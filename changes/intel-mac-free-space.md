- On an Intel Mac, backups and automatic updates work again. The office Mac read the free disk space as 0 MB (the
  bundled Bun gives wrong disk numbers on Intel Macs), so every backup said "not enough free disk space" and every
  update stopped at the backup before it. The server now checks the numbers and, when they cannot be right, asks the
  system's `df`. When neither can be read, a backup goes ahead with a warning instead of refusing, and Admin ›
  System shows "Could not read the free space" instead of an error. An Intel office Mac on an older version cannot
  update itself to this one (its own old backup step runs first): install the new office zip by hand once.
