//go:build linux && cgo

package main

// builtWithCgo: syscall.AllThreadsSyscall (dropCaps, netns_linux.go) refuses to run in a cgo binary, so exec
// --net-proxy fails closed with a plain reason. native/build.sh builds with CGO_ENABLED=0.
const builtWithCgo = true
