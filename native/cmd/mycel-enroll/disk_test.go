package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// The late data disk (Lightsail plan 6.3): hostd attaches it after the instance runs, so the cloud path waits for it.

const (
	lsblkRootOnly = `{"blockdevices":[{"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","fstype":null,"mountpoints":[null],"size":85899345920,"children":[{"name":"nvme0n1p1","path":"/dev/nvme0n1p1","type":"part","fstype":"ext4","mountpoints":["/"]}]}]}`
	lsblkLateDisk = `{"blockdevices":[{"name":"nvme0n1","path":"/dev/nvme0n1","type":"disk","fstype":null,"mountpoints":[null],"size":85899345920,"children":[{"name":"nvme0n1p1","path":"/dev/nvme0n1p1","type":"part","fstype":"ext4","mountpoints":["/"]}]},{"name":"nvme1n1","path":"/dev/nvme1n1","type":"disk","fstype":null,"mountpoints":[null],"size":85899345920}]}`
	lsblkTwoBlank = `{"blockdevices":[{"name":"nvme1n1","path":"/dev/nvme1n1","type":"disk","fstype":null,"mountpoints":[null],"size":1},{"name":"nvme2n1","path":"/dev/nvme2n1","type":"disk","fstype":null,"mountpoints":[null],"size":1}]}`
)

// lateHarness: a harness whose Sleep runs at(n) after the n-th wait (n from 1), to attach a disk while enroll waits.
func lateHarness(t *testing.T, at func(h *harness, n int)) *harness {
	t.Helper()
	w, p := dataDiskWait, dataDiskPoll
	dataDiskWait, dataDiskPoll = 30*time.Second, 5*time.Second // 6 waits
	t.Cleanup(func() { dataDiskWait, dataDiskPoll = w, p })
	h := newHarness(t)
	h.run.lsblk = lsblkRootOnly
	h.e.Sleep = func(d time.Duration) {
		h.sleeps = append(h.sleeps, d)
		if at != nil {
			at(h, len(h.sleeps))
		}
	}
	return h
}

func TestLateDiskReattach(t *testing.T) {
	h := lateHarness(t, func(h *harness, n int) {
		if n == 3 {
			h.run.labelDev = "/dev/nvme1n1"
		}
	})
	must(t, h.e.dataDisk(true, false))
	if len(h.sleeps) != 3 || h.sleeps[0] != 5*time.Second {
		t.Fatalf("sleeps %v", h.sleeps)
	}
	if mn := h.run.named("mount"); len(mn) != 1 || mn[0].args[len(mn[0].args)-2] != "/dev/nvme1n1" {
		t.Fatalf("mount %+v", mn)
	}
	if len(h.run.named("mkfs.ext4")) != 0 || len(h.run.named("lsblk")) != 0 {
		t.Fatal("reattach formatted or looked for a blank disk")
	}
	if len(h.run.named("udevadm")) != 3 {
		t.Fatalf("udevadm settle after each wait: %+v", h.run.named("udevadm"))
	}
	if out := h.out.String(); !strings.Contains(out, "waiting up to 30s") || !strings.Contains(out, "the data disk is here after") {
		t.Fatalf("log %q", out)
	}
}

func TestLateDiskNew(t *testing.T) {
	h := lateHarness(t, func(h *harness, n int) {
		if n == 2 {
			h.run.lsblk = lsblkLateDisk
		}
	})
	must(t, h.e.dataDisk(false, false))
	if len(h.sleeps) != 2 {
		t.Fatalf("sleeps %v", h.sleeps)
	}
	if mk := h.run.named("mkfs.ext4"); len(mk) != 1 || mk[0].args[len(mk[0].args)-1] != "/dev/nvme1n1" {
		t.Fatalf("mkfs %+v", mk)
	}
	if mn := h.run.named("mount"); len(mn) != 1 || mn[0].args[len(mn[0].args)-2] != "/dev/nvme1n1" {
		t.Fatalf("mount %+v", mn)
	}
}

func TestLateDiskNeverComes(t *testing.T) {
	for _, reattach := range []bool{false, true} {
		h := lateHarness(t, nil)
		err := h.e.dataDisk(reattach, false)
		var f *failure
		if !errors.As(err, &f) || f.Code != "data_disk_missing" || !strings.Contains(f.Msg, "waited 30s") {
			t.Fatalf("reattach=%v: %v", reattach, err)
		}
		if len(h.sleeps) != 6 || len(h.run.named("mkfs.ext4")) != 0 || len(h.run.named("mount")) != 0 {
			t.Fatalf("reattach=%v: sleeps %v, mkfs %d", reattach, h.sleeps, len(h.run.named("mkfs.ext4")))
		}
	}
}

// the image's mount unit (or its udev rule) mounts the disk while enroll waits: enroll uses that mount
func TestLateDiskMountedByTheImage(t *testing.T) {
	h := lateHarness(t, func(h *harness, n int) {
		if n == 4 {
			h.mounted = true
		}
	})
	must(t, h.e.dataDisk(true, false))
	if len(h.sleeps) != 4 || len(h.run.named("mount")) != 0 {
		t.Fatalf("sleeps %v, mount %+v", h.sleeps, h.run.named("mount"))
	}
}

// two blank disks while waiting: fail at once, never guess
func TestLateDiskAmbiguous(t *testing.T) {
	h := lateHarness(t, func(h *harness, n int) {
		if n == 1 {
			h.run.lsblk = lsblkTwoBlank
		}
	})
	err := h.e.dataDisk(false, false)
	var f *failure
	if !errors.As(err, &f) || f.Code != "data_disk_ambiguous" || len(h.sleeps) != 1 {
		t.Fatalf("%v, sleeps %v", err, h.sleeps)
	}
}

// EC2 and Proxmox: the disk is there at once, so no wait. Standalone, --data-device none and an explicit device never
// wait.
func TestDataDiskNoWait(t *testing.T) {
	cases := []struct {
		name               string
		reattach, alone    bool
		device, label, lsb string
		wantErr            string
	}{
		{name: "new, disk there", lsb: lsblkLateDisk},
		{name: "reattach, label there", reattach: true, label: "/dev/nvme1n1"},
		{name: "standalone, no disk", alone: true, lsb: lsblkRootOnly},
		{name: "none", device: "none", lsb: lsblkRootOnly},
		{name: "explicit device", device: "/dev/vdc"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := lateHarness(t, nil)
			h.run.labelDev, h.run.lsblk = c.label, c.lsb
			if c.device != "" {
				h.e.O.DataDevice = c.device
			}
			must(t, h.e.dataDisk(c.reattach, c.alone))
			if len(h.sleeps) != 0 || len(h.run.named("udevadm")) != 0 || strings.Contains(h.out.String(), "waiting") {
				t.Fatalf("waited: %v %q", h.sleeps, h.out.String())
			}
		})
	}
}

// the image's mount unit mounted the new label first, so our own mount fails: BASE is a mount point, that is success
func TestMountRaceWithTheImageUnit(t *testing.T) {
	h := newHarness(t)
	h.run.lsblk = lsblkLateDisk
	h.run.failNames["mount"] = &CmdError{Name: "mount", Code: 32, Stderr: "already mounted"}
	h.e.IsMountpoint = func(string) bool { return len(h.run.named("mount")) > 0 }
	must(t, h.e.dataDisk(false, false))
	// a mount that fails while BASE is still no mount point stays an error
	h = newHarness(t)
	h.run.lsblk = lsblkLateDisk
	h.run.failNames["mount"] = &CmdError{Name: "mount", Code: 32}
	var f *failure
	if err := h.e.dataDisk(false, false); !errors.As(err, &f) || f.Code != "data_disk_failed" {
		t.Fatalf("%v", err)
	}
}

// blkid names a device that cannot be mounted yet (a stale cache entry, a disk still being attached): check again
func TestLateDiskMountRetried(t *testing.T) {
	h := lateHarness(t, func(h *harness, n int) {
		if n == 2 {
			delete(h.run.failNames, "mount")
		}
	})
	h.run.labelDev = "/dev/nvme1n1"
	h.run.failNames["mount"] = &CmdError{Name: "mount", Code: 32, Stderr: "can't read superblock"}
	must(t, h.e.dataDisk(true, false))
	if len(h.sleeps) != 2 || len(h.run.named("mount")) != 3 || !strings.Contains(h.out.String(), "trying again") {
		t.Fatalf("sleeps %v, mounts %d, log %q", h.sleeps, len(h.run.named("mount")), h.out.String())
	}
	// with no wait left the mount error is the result
	h = lateHarness(t, nil)
	h.run.labelDev = "/dev/nvme1n1"
	h.run.failNames["mount"] = &CmdError{Name: "mount", Code: 32}
	var f *failure
	if err := h.e.dataDisk(true, false); !errors.As(err, &f) || f.Code != "data_disk_failed" || len(h.sleeps) != 6 {
		t.Fatalf("%v, sleeps %v", err, h.sleeps)
	}
}
