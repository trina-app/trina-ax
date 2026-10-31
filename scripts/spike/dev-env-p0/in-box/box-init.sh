#!/bin/sh
# PID 1 of a dev box: starts the forwarders to the per-box proxy sockets, then waits. No workload runs here; every
# command comes through `podman exec` after box.sh has loaded the network rules.
node /opt/trina/fwd.mjs 127.0.0.1:4000=/run/trina/model.sock 127.0.0.1:3128=/run/trina/egress.sock &
trap 'kill $! 2>/dev/null; exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
