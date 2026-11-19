package main

import "syscall"

// oNoatime: the read-ahead does not change the seed's access times (cp -a copies them) or write an inode per file.
const oNoatime = syscall.O_NOATIME
