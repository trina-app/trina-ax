package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// The binaries data-grow runs (tests replace them).
var (
	findmntBin   = "/usr/bin/findmnt"
	resize2fsBin = "/usr/sbin/resize2fs"
)

// data-grow: grow the ext4 file system of the data disk (mounted at the base, /var/lib/mycel) to the size of its block
// device, online. The hosting service calls it after it made the disk bigger (a trial team that starts to pay) when
// the file system still shows the old size; the image's udev rule normally grows it already, and resize2fs does
// nothing when the sizes match. { grown, beforeBytes, afterBytes } (statfs of the base before and after).
func cmdDataGrow(e *env, args []string) (int, error) {
	t := newTenant(e, "data-grow")
	if c, err := t.open(args); err != nil {
		return c, err
	}
	before, _, _, err := diskUsage(e.base)
	if err != nil {
		return 1, fmt.Errorf("statfs %s: %v", e.base, err)
	}
	src, err := exec.Command(findmntBin, "-n", "-o", "SOURCE", "--target", e.base).Output()
	if err != nil {
		return 1, fmt.Errorf("findmnt %s: %v", e.base, err)
	}
	dev := strings.TrimSpace(string(src))
	// a block device only (never a bind mount's "dev[/path]" or a tmpfs): resize2fs gets nothing else
	if !strings.HasPrefix(dev, "/dev/") || strings.ContainsAny(dev, "[] \n") {
		return 1, fmt.Errorf("the data folder %s is not on a block device (%q)", e.base, dev)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, resize2fsBin, dev).CombinedOutput()
	if err != nil {
		return 1, fmt.Errorf("resize2fs %s: %v %s", dev, err, tailLines(strings.TrimSpace(string(out)), 5))
	}
	after, _, _, err := diskUsage(e.base)
	if err != nil {
		return 1, fmt.Errorf("statfs %s: %v", e.base, err)
	}
	return t.out(map[string]any{"grown": after > before, "beforeBytes": before, "afterBytes": after})
}
