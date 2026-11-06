# Disk probe, sent into the box as a job by vm-tests.sh: fill /work (the team folder on the server's disk, not the box
# volume) until boxd stops the box. The box has no fallocate, so vm-tests.sh takes most of the space on the host first. dd
# then writes at disk speed, so the distance from the floor to the stop is the real one.
dd if=/dev/zero of=/work/fill.bin bs=1M 2>&1
