// mycel-link: the ax-link agent in a Team AX tenant on EC2 (and Oracle). It is the guest channel of the hostd ec2
// driver and does what the qemu guest agent does on Proxmox (trina-cloud docs/research/ec2-per-team.md §6; the server
// is trina-cloud hostd/hostd/src/link.ts).
//
// cloud-init writes /etc/ax/link.json at the first boot: { v, tenantId, url, pin, token }. The agent
//
//	key       loads or makes its Ed25519 key in /var/lib/ax-link/key (root disk: a reimage makes a new one)
//	register  POST /link/v1/register with the one-time token; after 200 it removes the token from link.json
//	poll      signed long poll (<= 25 s) with the boot id and the ids it runs; a poll is also the "online" signal
//	run       the allow-listed argv only (exec, no shell, as root, stdin on fd 0), at most 4 at a time, killed at
//	          timeoutSec (timedOut: true)
//	result    signed POST /link/v1/result; kept in /run/ax-link/ until hostd answers 200, so a restart sends it again
//
// TLS: the agent accepts only a certificate whose SubjectPublicKeyInfo SHA-256 (base64url) equals pin. The key type
// does not matter (hostd uses ECDSA P-256). The log never holds the token, stdin, stdout or stderr of a command.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
)

// agentVersion goes to hostd at register (its log only)
const agentVersion = "1"

func main() {
	var o Options
	var version bool
	flag.StringVar(&o.ConfigFile, "config", "/etc/ax/link.json", "link.json written by cloud-init (url, pin, one-time token)")
	flag.StringVar(&o.StateDir, "state-dir", "/var/lib/ax-link", "the agent key (persistent, root disk)")
	flag.StringVar(&o.SpoolDir, "spool-dir", "/run/ax-link", "results not yet sent to hostd (tmpfs)")
	flag.BoolVar(&version, "version", false, "print the version and exit")
	flag.Parse()
	if version {
		fmt.Println("mycel-link", agentVersion)
		return
	}
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "mycel-link: unexpected argument %q\n", flag.Arg(0))
		os.Exit(2)
	}
	// journald adds the time
	o.Log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
		if a.Key == slog.TimeKey {
			return slog.Attr{}
		}
		return a
	}}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	a, err := New(o)
	if err != nil {
		o.Log.Error("mycel-link cannot start", "error", err.Error())
		os.Exit(1)
	}
	if err := a.Run(ctx); err != nil && ctx.Err() == nil {
		o.Log.Error("mycel-link stopped", "error", err.Error())
		os.Exit(1)
	}
}
