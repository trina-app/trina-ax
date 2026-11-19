package main

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
)

// seedMarker is written into BASE before the seed copy starts and removed once the copy is on the disk. A seed that
// stopped half way (a reboot, a kill, a full disk) can already hold root/VERSION, so VERSION alone does not mean "an
// install": with the marker there the next try copies again (cp -a over the half tree).
const seedMarker = ".seed-incomplete"

// defaultSeedReaders: how many files the read-ahead reads at once. On EC2 the seed is on the root volume, which EBS
// fills from the AMI snapshot in S3 on the first read of each block; one reader at a time waits on S3 for every block
// (about 6 MB/s), many readers keep many block fetches in flight. 32 stays under the gp3 baseline of 3000 IOPS.
const defaultSeedReaders = 32

// readAheadChunk: a file bigger than two chunks is read as chunks by several readers (the app's bun and node
// binaries are tens of MB; one reader would make them the tail of the read-ahead).
const readAheadChunk = 4 << 20

// seedReaders is AX_ENROLL_SEED_READERS (0 turns the read-ahead off), else the default.
func (e *Enroller) seedReaders() int {
	if v := e.Getenv("AX_ENROLL_SEED_READERS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 256 {
			return n
		}
		_, _ = io.WriteString(e.Out, "mycel-enroll: seed: AX_ENROLL_SEED_READERS="+strconv.Quote(v)+" is not 0..256, using the default\n")
	}
	return defaultSeedReaders
}

type readAheadStats struct {
	Files  int64 // regular files read to the end
	Bytes  int64
	Errors int64 // entries that could not be listed or read (the copy after it reports what matters)
}

// readAheadItem is a folder to list, or a part of a regular file to read (off 0 = the whole file, or its first chunk).
type readAheadItem struct {
	path  string
	dir   bool
	off   int64
	whole bool // the file's first item: it looks at the size and splits off the other chunks
}

// readAhead reads every regular file under root once, to nothing, with `workers` goroutines that also list the folders
// in parallel (the folders and inodes are blocks on the volume too). Links are not followed and nothing is written.
// It is best effort: errors are only counted.
func readAhead(root string, workers int) readAheadStats {
	if workers < 1 {
		workers = 1
	}
	var (
		mu    sync.Mutex
		cond  = sync.NewCond(&mu)
		queue = []readAheadItem{{path: root, dir: true}}
		busy  int
		st    readAheadStats
		wg    sync.WaitGroup
	)
	worker := func() {
		defer wg.Done()
		buf := make([]byte, 1<<20)
		for {
			mu.Lock()
			for len(queue) == 0 && busy > 0 {
				cond.Wait()
			}
			if len(queue) == 0 { // nothing left and nobody can add more
				mu.Unlock()
				cond.Broadcast()
				return
			}
			it := queue[len(queue)-1]
			queue = queue[:len(queue)-1]
			busy++
			mu.Unlock()

			var more []readAheadItem
			if it.dir {
				more = readAheadDir(it.path, &st)
			} else {
				more = readAheadFile(it, buf, &st)
			}

			mu.Lock()
			busy--
			queue = append(queue, more...)
			mu.Unlock()
			cond.Broadcast()
		}
	}
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go worker()
	}
	wg.Wait()
	return st
}

func readAheadDir(dir string, st *readAheadStats) []readAheadItem {
	ents, err := os.ReadDir(dir)
	if err != nil {
		atomic.AddInt64(&st.Errors, 1)
	}
	out := make([]readAheadItem, 0, len(ents))
	for _, d := range ents {
		p := filepath.Join(dir, d.Name())
		switch t := d.Type(); {
		case t.IsDir():
			out = append(out, readAheadItem{path: p, dir: true})
		case t.IsRegular():
			out = append(out, readAheadItem{path: p, whole: true})
		}
		// links, sockets, devices: cp -a makes them from the entry itself, there is nothing to read
	}
	return out
}

func readAheadFile(it readAheadItem, buf []byte, st *readAheadStats) []readAheadItem {
	f, err := os.OpenFile(it.path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		atomic.AddInt64(&st.Errors, 1)
		return nil
	}
	defer f.Close()
	var more []readAheadItem
	end := int64(-1) // read to EOF
	if it.whole {
		fi, err := f.Stat()
		if err != nil || !fi.Mode().IsRegular() { // swapped for a FIFO or a device since the listing: do not read
			atomic.AddInt64(&st.Errors, 1)
			return nil
		}
		if size := fi.Size(); size > 2*readAheadChunk {
			end = readAheadChunk
			for off := int64(readAheadChunk); off < size; off += readAheadChunk {
				more = append(more, readAheadItem{path: it.path, off: off})
			}
		}
		atomic.AddInt64(&st.Files, 1)
	} else {
		end = it.off + readAheadChunk
	}
	off := it.off
	for end < 0 || off < end {
		n := len(buf)
		if end >= 0 && int64(n) > end-off {
			n = int(end - off)
		}
		r, err := f.ReadAt(buf[:n], off)
		off += int64(r)
		atomic.AddInt64(&st.Bytes, int64(r))
		if err != nil {
			if err != io.EOF {
				atomic.AddInt64(&st.Errors, 1)
			}
			break
		}
	}
	return more
}

// writeSeedMarker creates the marker and makes it durable before the copy writes anything: after a crash the marker
// is there whenever any copied file is.
func writeSeedMarker(base string) error {
	// BASE is the data disk's mount point; cp -a gives it the seed folder's owner and mode
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(base, seedMarker), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteString("the kit seed copy has not finished; the next mycel-enroll copies it again\n"); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return syncDir(base)
}

// clearSeedMarker flushes the copy to the disk (with delayed allocation a crash could otherwise leave empty files that
// the journal already names) and only then removes the marker.
func clearSeedMarker(seed, base string) error {
	syscall.Sync()
	if err := os.Remove(filepath.Join(base, seedMarker)); err != nil && !os.IsNotExist(err) {
		return err
	}
	// the removal changed BASE's time: give it the seed folder's again, as cp -a set it
	if fi, err := os.Stat(seed); err == nil {
		_ = os.Chtimes(base, fi.ModTime(), fi.ModTime())
	}
	return syncDir(base)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
