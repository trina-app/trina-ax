package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// The data disk (isolation §5.1): ext4, label axdata, mounted at BASE. Rules, in order:
//  1. BASE is already a mount point (the image's var-lib-mycel.mount found it, a docker volume): use it.
//  2. A filesystem labelled axdata exists: mount it.
//  3. reattach never formats: no axdata disk is a failure (the data must be there).
//  4. --data-device none: keep BASE on the root filesystem. Self-host falls back to this when no blank disk exists.
//  5. Otherwise pick the blank disk (--data-device PATH, or auto: the only whole disk that has no partitions, no
//     filesystem, no mounts), confirm with `blkid -p` that it carries no signature at all, mkfs.ext4 -L axdata, mount.
//     A disk with ANY signature (partition table, filesystem, LVM, RAID…) is never formatted.

const dataLabel = "axdata"

func (e *Enroller) dataDisk(reattach, standalone bool) error {
	ctx := context.Background()
	if e.IsMountpoint(e.P.Base) {
		return nil
	}
	if err := mkdirRoot(e.P.Base); err != nil {
		return fail("data_disk_failed", "create %s: %v", e.P.Base, err)
	}
	// 2. an existing axdata filesystem (blkid -L prints the device, exit 2 when none)
	if out, err := e.Run.Run(ctx, "blkid", []string{"-L", dataLabel}, nil); err == nil {
		dev := strings.TrimSpace(string(out))
		if dev != "" {
			return e.mount(dev)
		}
	} else if exitCode(err) != 2 {
		return fail("data_disk_failed", "blkid -L %s: %v", dataLabel, err)
	}
	if reattach {
		return fail("data_disk_missing", "reattach: no filesystem labelled %s (the data disk must be attached)", dataLabel)
	}
	if e.O.DataDevice == "none" {
		return nil
	}
	dev := e.O.DataDevice
	if dev == "auto" {
		cands, err := e.blankDisks()
		if err != nil {
			return err
		}
		switch {
		case len(cands) == 1:
			dev = cands[0]
		case len(cands) == 0 && standalone:
			fmt.Fprintf(e.Out, "mycel-enroll: no empty data disk found: %s stays on the system disk\n", e.P.Base)
			return nil
		case len(cands) == 0:
			return fail("data_disk_missing", "no blank data disk found (expected one unpartitioned disk without a filesystem)")
		default:
			return fail("data_disk_ambiguous", "more than one blank disk (%s): name one with --data-device", strings.Join(cands, ", "))
		}
	}
	// blkid -p (low-level probe, no cache): exit 2 = nothing found. Exit 0 = some signature: refuse.
	out, err := e.Run.Run(ctx, "blkid", []string{"-p", dev}, nil)
	switch {
	case err == nil:
		return fail("data_disk_not_blank", "%s is not blank (%s): refusing to format it", dev, strings.TrimSpace(string(out)))
	case exitCode(err) != 2:
		return fail("data_disk_failed", "blkid -p %s: %v", dev, err)
	}
	if _, err := e.Run.Run(ctx, "mkfs.ext4", []string{"-q", "-L", dataLabel, "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1", dev}, nil); err != nil {
		return fail("data_disk_failed", "mkfs.ext4 %s: %v", dev, err)
	}
	return e.mount(dev)
}

func (e *Enroller) mount(dev string) error {
	if _, err := e.Run.Run(context.Background(), "mount", []string{"-t", "ext4", "-o", "noatime", dev, e.P.Base}, nil); err != nil {
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
