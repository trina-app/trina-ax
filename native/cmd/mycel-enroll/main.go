// mycel-enroll: first boot of a Team AX tenant VM (isolation.md §5.4, control-plane.md §3.5.2, CT-2), and the first
// start of a self-hosted VM made from the same image (--standalone, isolation.md §5.2 item 3).
//
// Cloud (Team AX Cloud): ax-hostd writes /run/ax/enroll.json through cloud-init and starts mycel-enroll.service. This
// program then
//
//	read-config  parse enroll.json (ee/cloud/contracts/substrate.ts EnrollFile)
//	data-disk    mount the data disk (ext4, label axdata) at BASE, formatting it only when it is completely blank
//	seed         copy the kit the image installed (/usr/lib/mycel/seed-base) into BASE when BASE holds no install
//	relay-key    create the team's relay Ed25519 key IN the VM (<data>/relay/team-key.pem); the private key never leaves
//	enroll       POST {controlPlane}/enroll with the one-time token: setup token, relay registration, plan, notices
//	apply        server.json, /etc/default/mycel, plan/notices (mycel-ctl), registration.json, setup-token, restore
//	start        enable and start the mycel units, disable cloud-init
//	done         /run/ax/enroll-status.json {"state":"ok"} (ax-hostd reads it through the guest agent)
//
// Every step is written to the status file, so the host sees where a failure happened. Modes: new (a new team),
// restore (a team restored from its offsite backup into this new VM), verify (restore test: restore and check, never
// start), reattach (after reimageTenant: the data disk already holds the install; no token, no network call).
//
// Self-host (--standalone): mount/seed as above (the data disk is optional), write a local first-setup token and print
// how to open the setup page. No control plane is involved.
//
// The decisions behind the layout (BASE on the data disk, the seed, fixed uids 990/991) are in docs/DECISIONS.md
// ("클라우드 호스트") and ee/cloud/README.md.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	var (
		p    Paths
		o    Options
		unit string
	)
	flag.StringVar(&p.EnrollFile, "enroll-file", "/run/ax/enroll.json", "enroll.json written by ax-hostd (cloud-init)")
	flag.StringVar(&p.StatusFile, "status-file", "/run/ax/enroll-status.json", "progress and result, read by ax-hostd")
	flag.StringVar(&p.Base, "base", "/var/lib/mycel", "install base; the data disk is mounted here")
	flag.StringVar(&p.Seed, "seed", "/usr/lib/mycel/seed-base", "the kit installed by the image build (copied into an empty BASE)")
	flag.StringVar(&o.DataDevice, "data-device", "auto", "auto | none | a block device path")
	flag.BoolVar(&o.Standalone, "standalone", false, "self-host: no control plane; write a local first-setup token")
	flag.BoolVar(&o.NoStart, "no-start", false, "do everything except enabling/starting the units (tests, image checks)")
	flag.StringVar(&unit, "units", strings.Join(defaultUnits, ","), "units to enable and start")
	flag.Parse()
	if flag.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "mycel-enroll: unexpected argument %q\n", flag.Arg(0))
		os.Exit(2)
	}
	if !strings.HasPrefix(p.Base, "/") || !strings.HasPrefix(p.Seed, "/") {
		fmt.Fprintln(os.Stderr, "mycel-enroll: --base and --seed must be absolute paths")
		os.Exit(2)
	}
	switch o.DataDevice {
	case "auto", "none":
	default:
		if !strings.HasPrefix(o.DataDevice, "/dev/") {
			fmt.Fprintln(os.Stderr, "mycel-enroll: --data-device takes auto, none or a /dev/... path")
			os.Exit(2)
		}
	}
	for _, u := range strings.Split(unit, ",") {
		if u = strings.TrimSpace(u); u != "" {
			o.Units = append(o.Units, u)
		}
	}
	p.DefaultFile = "/etc/default/mycel"
	p.CloudInitDisabled = "/etc/cloud/cloud-init.disabled"
	p.ServerUser = "axserver"

	e := &Enroller{
		P: p, O: o,
		Run:           execRunner{},
		HTTP:          &http.Client{Timeout: 60 * time.Second},
		Now:           time.Now,
		Sleep:         time.Sleep,
		IsMountpoint:  isMountpoint,
		Systemd:       systemdRunning(),
		LookupUser:    lookupUser,
		Chown:         os.Lchown,
		Getenv:        os.Getenv,
		Out:           os.Stdout,
		RetryDeadline: 5 * time.Minute,
	}
	if err := e.Main(); err != nil {
		fmt.Fprintf(os.Stderr, "mycel-enroll: %v\n", err)
		os.Exit(1)
	}
}
