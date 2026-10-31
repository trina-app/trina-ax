package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"sync"
	"time"

	"mycel/native/internal/peer"
)

var (
	listen    = flag.String("listen", "/run/mycel-boxd/boxd.sock", "socket the server connects to")
	serverUID = flag.Int("server-uid", -1, "only this uid may send requests (the team server account)")
	serverGID = flag.Int("server-gid", -1, "group of the server account (owner of the team folder files)")
	teamRoot  = flag.String("team-root", "", "the team folder root; a box folder must be a real folder below it")
	boxUser   = flag.String("box-user", "mycel-devbox", "account that owns every box (rootless podman)")
	stateDir  = flag.String("state-dir", "/var/lib/mycel-boxd", "box volumes and mount points (root only)")
	runDir    = flag.String("run-dir", "/run/mycel-boxd", "sockets and per-box run files")
	image     = flag.String("image", "localhost/mycel-devbox:1", "box image (no AI engine in it)")
	seccompF  = flag.String("seccomp", "/etc/mycel-boxd/box-seccomp.json", "box seccomp profile (scripts/dev-env/make-seccomp.py)")
	maxBoxes  = flag.Int("max-running", 1, "boxes that may run at the same time (P0 spike section 4.4: one on a 4 GB VM)")
)

// box: what boxd knows of one box while it runs (state on disk is podman's).
type box struct {
	mu         sync.Mutex // one op of a box at a time (ensure, stop, exec start)
	id         string
	startedAt  time.Time
	lastActive time.Time
	idle       time.Duration
	previews   map[int]net.Listener
	running    bool
}

var boxes = struct {
	sync.Mutex
	m map[string]*box
}{m: map[string]*box{}}

func boxOf(id string) *box {
	boxes.Lock()
	defer boxes.Unlock()
	b := boxes.m[id]
	if b == nil {
		b = &box{id: id, previews: map[int]net.Listener{}}
		boxes.m[id] = b
	}
	return b
}

func (b *box) touch() {
	boxes.Lock()
	b.lastActive = time.Now()
	boxes.Unlock()
}

type out struct {
	mu sync.Mutex
	c  net.Conn
}

func (o *out) send(v any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	b, _ := json.Marshal(v)
	o.c.Write(append(b, '\n'))
}

func errEv(err error) map[string]any { return map[string]any{"ev": "error", "message": err.Error()} }

func main() {
	flag.Parse()
	log.SetFlags(log.LstdFlags | log.LUTC)
	if *serverUID < 0 || *serverGID < 0 || *teamRoot == "" {
		fmt.Fprintln(os.Stderr, "mycel-boxd: --server-uid, --server-gid and --team-root are required")
		os.Exit(2)
	}
	if err := setup(); err != nil {
		// keep serving status: the server shows why boxes are not available
		log.Printf("setup: %v", err)
	}
	os.Remove(*listen)
	ln, err := net.Listen("unix", *listen)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.Chown(*listen, *serverUID, *serverGID); err != nil {
		log.Fatal(err)
	}
	os.Chmod(*listen, 0600)
	go reaper()
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Fatal(err)
		}
		go serve(c.(*net.UnixConn))
	}
}

func serve(c *net.UnixConn) {
	defer c.Close()
	o := &out{c: c}
	cr, err := peer.Of(c)
	if err != nil || cr.Uid != *serverUID {
		o.send(map[string]any{"ev": "error", "message": "only the server may use boxd"})
		return
	}
	r := bufio.NewReaderSize(c, 256<<10)
	line, err := r.ReadBytes('\n')
	if err != nil {
		return
	}
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		o.send(errEv(fmt.Errorf("bad request")))
		return
	}
	if err := checkRequest(&req); err != nil {
		o.send(errEv(err))
		return
	}
	switch req.Op {
	case "status":
		o.send(statusEv())
	case "ensure":
		info, err := ensure(&req)
		if err != nil {
			log.Printf("ensure %s: %v", req.Box, err)
			o.send(errEv(err))
			return
		}
		o.send(map[string]any{"ev": "ok", "box": info})
	case "stop", "destroy":
		if err := stop(req.Box, req.Op == "destroy"); err != nil {
			o.send(errEv(err))
			return
		}
		o.send(map[string]any{"ev": "ok"})
	case "exec":
		stopped := make(chan struct{})
		go func() { // the server closed the connection: stop the command
			r.ReadBytes('\n')
			close(stopped)
		}()
		ev, err := execIn(&req, stopped)
		if err != nil {
			o.send(errEv(err))
			return
		}
		log.Printf("exec %s by %s: %v %vms", req.Box, req.Actor, ev["code"], ev["ms"])
		o.send(ev)
	case "ps":
		ps, err := processes(req.Box)
		if err != nil {
			o.send(errEv(err))
			return
		}
		o.send(map[string]any{"ev": "ps", "processes": ps})
	case "preview":
		p, err := preview(req.Box, req.Port)
		if err != nil {
			o.send(errEv(err))
			return
		}
		o.send(map[string]any{"ev": "preview", "socket": p})
	case "netlog":
		lines, err := netlog(req.Box)
		if err != nil {
			o.send(errEv(err))
			return
		}
		o.send(map[string]any{"ev": "netlog", "lines": lines})
	}
}

// reaper stops boxes after their idle time (no command, no preview connection).
func reaper() {
	for range time.Tick(time.Minute) {
		var idle []string
		boxes.Lock()
		for id, b := range boxes.m {
			if b.running && b.idle > 0 && time.Since(b.lastActive) > b.idle {
				idle = append(idle, id)
			}
		}
		boxes.Unlock()
		for _, id := range idle {
			log.Printf("idle stop %s", id)
			if err := stop(id, false); err != nil {
				log.Printf("idle stop %s: %v", id, err)
			}
		}
	}
}
