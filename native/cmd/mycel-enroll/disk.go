package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// The data disk (isolation §5.1): ext4, label axdata, mounted at BASE. Rules, in order:
//  1. BASE is already a mount point (the image's var-lib-mycel.mount found it, a docker volume): use it.
//  2. A filesystem labelled axdata exists: mount it.
//  3. reattach never formats: no axdata disk is a failure (the data must be there).
//  4. --data-device none: keep BASE on the root filesystem. Self-host falls back to this when no blank disk exists.
//  5. Otherwise pick the blank disk (--data-device PATH, or auto: the only whole disk that has no partitions, no
//     filesystem, no mounts), confirm with `blkid -p` that it carries no signature at all, mkfs.ext4 -L axdata, mount.
//     A disk with ANY signature (partition table, filesystem, LVM, RAID…) is never formatted.
//
// The late disk (Lightsail plan 6.3): on Lightsail hostd attaches the data disk only after the instance runs, so the
// cloud path (not standalone, not --data-device none, not an explicit device) waits for it before rules 1-5 fail with
// data_disk_missing: up to dataDiskWait, a check every dataDiskPoll (after `udevadm settle`, so a disk that was just
// added has its label). Each check runs rules 1, 2 and the auto pick again: the image's mount unit (or its udev rule)
// can mount the disk while we wait. On EC2 and Proxmox the disk is there at once and the first check finds it.

const dataLabel = "axdata"

var (
	dataDiskWait = 10 * time.Minute
	dataDiskPoll = 5 * time.Second
)

func (e *Enroller) dataDisk(reattach, standalone bool) error {
	if e.IsMountpoint(e.P.Base) {
		return nil
	}
	if err := mkdirRoot(e.P.Base); err != nil {
		return fail("data_disk_failed", "create %s: %v", e.P.Base, err)
	}
	if e.O.DataDevice == "none" && !reattach {
		// rule 4 comes after rule 2: an axdata disk that is there is still used
		dev, err := e.labelled()
		if err != nil || dev == "" {
			return err
		}
		return e.mount(dev)
	}
	wait := !standalone && (reattach || e.O.DataDevice == "auto")
	polls := 0
	if wait {
		polls = int(dataDiskWait / dataDiskPoll)
	}
	var start time.Time
	for i := 0; ; i++ {
		// the count bounds the wait in tests (a Sleep that returns at once); the clock bounds it on a real machine,
		// where each round is a poll plus `udevadm settle`
		more := i < polls && (i == 0 || e.Now().Sub(start) < dataDiskWait)
		done, dev, err := e.findDataDisk(reattach, standalone, more)
		if err == nil && (done || dev != "") && i > 0 {
			fmt.Fprintf(e.Out, "mycel-enroll: the data disk is here after %s\n", e.Now().Sub(start).Round(time.Second))
		}
		switch {
		case err != nil || done:
			return err
		case dev != "":
			return e.format(dev)
		}
		if i == 0 {
			start = e.Now()
			fmt.Fprintf(e.Out, "mycel-enroll: no data disk yet: waiting up to %s for it to be attached\n", dataDiskWait)
		}
		e.Sleep(dataDiskPoll)
		_, _ = e.Run.Run(context.Background(), "udevadm", []string{"settle", "--timeout=10"}, nil)
	}
}

// labelled is rule 2: the device of an existing axdata filesystem (blkid -L prints it, exit 2 when none), or "".
func (e *Enroller) labelled() (string, error) {
	out, err := e.Run.Run(context.Background(), "blkid", []string{"-L", dataLabel}, nil)
	if err == nil {
		return strings.TrimSpace(string(out)), nil
	}
	if exitCode(err) != 2 {
		return "", fail("data_disk_failed", "blkid -L %s: %v", dataLabel, err)
	}
	return "", nil
}

// findDataDisk is one check of rules 1-5. done: BASE is ready (mounted, or stays on the system disk). dev: the blank
// disk to format. Neither and no error: nothing yet, and more checks follow (more = true; with more false, fail).
func (e *Enroller) findDataDisk(reattach, standalone, more bool) (done bool, dev string, err error) {
	last := !more
	if e.IsMountpoint(e.P.Base) {
		return true, "", nil
	}
	if l, err := e.labelled(); err != nil {
		return false, "", err
	} else if l != "" {
		err := e.mount(l)
		if err != nil && more {
			// a disk that is still being attached, or a device name that blkid's cache kept from a disk that is
			// gone (found in tests/cloud/enroll): check again after the next wait
			fmt.Fprintf(e.Out, "mycel-enroll: %v: trying again\n", err)
			return false, "", nil
		}
		return err == nil, "", err
	}
	if reattach {
		if last {
			return false, "", fail("data_disk_missing", "reattach: no filesystem labelled %s (the data disk must be attached; waited %s)", dataLabel, dataDiskWait)
		}
		return false, "", nil
	}
	if e.O.DataDevice != "auto" {
		return false, e.O.DataDevice, nil
	}
	cands, err := e.blankDisks()
	if err != nil {
		return false, "", err
	}
	switch {
	case len(cands) == 1:
		return false, cands[0], nil
	case len(cands) == 0 && standalone:
		fmt.Fprintf(e.Out, "mycel-enroll: no empty data disk found: %s stays on the system disk\n", e.P.Base)
		return true, "", nil
	case len(cands) == 0 && last:
		return false, "", fail("data_disk_missing", "no blank data disk found (expected one unpartitioned disk without a filesystem; waited %s)", dataDiskWait)
	case len(cands) == 0:
		return false, "", nil
	default:
		return false, "", fail("data_disk_ambiguous", "more than one blank disk (%s): name one with --data-device", strings.Join(cands, ", "))
	}
}

// format is rule 5 for the chosen disk: refuse any signature, mkfs.ext4 -L axdata, mount.
func (e *Enroller) format(dev string) error {
	ctx := context.Background()
	// blkid -p (low-level probe, no cache): exit 2 = nothing found. Exit 0 = some signature: refuse.
	out, err := e.Run.Run(ctx, "blkid", []string{"-p", dev}, nil)
	switch {
	case err == nil:
		return fail("data_disk_not_blank", "%s is not blank (%s): refusing to format it", dev, strings.TrimSpace(string(out)))
	case exitCode(err) != 2:
		return fail("data_disk_failed", "blkid -p %s: %v", dev, err)
	}
	// nodiscard: the disk is new and blank, so a full discard does no good. On a plan with a disk write limit, the
	// discard of a 160 GB disk takes about 17 minutes and enrollment fails on the hostd timeout (G-T2-13).
	if _, err := e.Run.Run(ctx, "mkfs.ext4", []string{"-q", "-L", dataLabel, "-m", "0", "-E", "nodiscard,lazy_itable_init=1,lazy_journal_init=1", dev}, nil); err != nil {
		return fail("data_disk_failed", "mkfs.ext4 %s: %v", dev, err)
	}
	return e.mount(dev)
}

func (e *Enroller) mount(dev string) error {
	if _, err := e.Run.Run(context.Background(), "mount", []string{"-t", "ext4", "-o", "noatime", dev, e.P.Base}, nil); err != nil {
		// the image's var-lib-mycel.mount (LABEL=axdata) can mount the disk first, for example right after mkfs gave
		// it the label: then BASE is a mount point and our mount failed only because of that
		if e.IsMountpoint(e.P.Base) {
			return nil
		}
		return fail("data_disk_failed", "mount %s on %s: %v", dev, e.P.Base, err)
	}
	if !e.IsMountpoint(e.P.Base) {
		return fail("data_disk_failed", "%s is not a mount point after mounting %s", e.P.Base, dev)
	}
	return nil
}

type lsblkDev struct {
	Name        string     `json:"name"`
	Path        string     `json:"path"`
	Type        string     `json:"type"`
	FSType      *string    `json:"fstype"`
	Mountpoints []*string  `json:"mountpoints"`
	Size        int64      `json:"size"`
	Children    []lsblkDev `json:"children"`
}

// blankDisks lists whole disks without partitions, filesystem or mounts (virtual, loop, RAM and zram devices aside).
func (e *Enroller) blankDisks() ([]string, error) {
	out, err := e.Run.Run(context.Background(), "lsblk", []string{"-J", "-b", "-o", "NAME,PATH,TYPE,FSTYPE,MOUNTPOINTS,SIZE"}, nil)
	if err != nil {
		return nil, fail("data_disk_failed", "lsblk: %v", err)
	}
	var r struct {
		Blockdevices []lsblkDev `json:"blockdevices"`
	}
	if err := json.Unmarshal(out, &r); err != nil {
		return nil, fail("data_disk_failed", "lsblk output: %v", err)
	}
	var c []string
	for _, d := range r.Blockdevices {
		if d.Type != "disk" || len(d.Children) > 0 || d.Size <= 0 {
			continue
		}
		if d.FSType != nil && *d.FSType != "" {
			continue
		}
		mounted := false
		for _, m := range d.Mountpoints {
			if m != nil && *m != "" {
				mounted = true
			}
		}
		skip := false
		for _, p := range []string{"zram", "loop", "ram", "nbd", "sr", "fd", "md"} {
			if strings.HasPrefix(d.Name, p) {
				skip = true
			}
		}
		if mounted || skip {
			continue
		}
		path := d.Path
		if path == "" {
			path = "/dev/" + d.Name
		}
		c = append(c, path)
	}
	return c, nil
}
