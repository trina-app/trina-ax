// Package fwstatus is the engine firewall's status file <base>/run/firewall.json (linux-runtime spec 3.4.2, D8):
// `mycel-ctl firewall apply|status` (root) writes it after loading and checking the nftables table; the launcher reads
// it before every turn and refuses the turn when it is missing, stale, not loaded, or for another uid or port (fail
// closed, spec 3.3.9); the server's diagnostics show it (shared/src/install.ts FirewallStatus).
package fwstatus

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Status is the file's shape (format 1).
type Status struct {
	Format     int     `json:"format"`
	At         string  `json:"at"`
	Backend    string  `json:"backend"`
	Table      string  `json:"table"`
	Loaded     bool    `json:"loaded"`
	Rules      int     `json:"rules"`
	EngineUID  int     `json:"engineUid"`
	ProxyPort  int     `json:"proxyPort"`
	Sha256     string  `json:"sha256"`
	NftVersion string  `json:"nftVersion"`
	Error      *string `json:"error"`
}

// MaxAge: the timer re-applies every 2 minutes; a status older than this means the timer stopped (spec 3.2.1).
const MaxAge = 10 * time.Minute

const maxBytes = 64 << 10

// Read reads the status file without following a link. ownerUID >= 0 also requires the file to be owned by that uid
// (root = 0 in production) and not writable by group or others.
func Read(path string, ownerUID int) (*Status, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var st syscall.Stat_t
	if err := syscall.Fstat(int(f.Fd()), &st); err != nil {
		return nil, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Size > maxBytes {
		return nil, fmt.Errorf("%s is not a small regular file", path)
	}
	if ownerUID >= 0 && (int(st.Uid) != ownerUID || st.Mode&0o022 != 0) {
		return nil, fmt.Errorf("%s is not owned by uid %d or is writable by others", path, ownerUID)
	}
	b, err := io.ReadAll(io.LimitReader(f, maxBytes))
	if err != nil {
		return nil, err
	}
	var s Status
	if err := json.Unmarshal(b, &s); err != nil || s.Format != 1 {
		return nil, fmt.Errorf("%s is not a format-1 firewall status", path)
	}
	return &s, nil
}

// Check returns nil when the status says the engine firewall for engineUID and proxyPort is loaded and fresh.
func (s *Status) Check(now time.Time, engineUID, proxyPort int) error {
	if !s.Loaded {
		msg := "not loaded"
		if s.Error != nil && *s.Error != "" {
			msg += ": " + *s.Error
		}
		return fmt.Errorf("%s", msg)
	}
	at, err := time.Parse(time.RFC3339Nano, s.At)
	if err != nil {
		return fmt.Errorf("no time")
	}
	if age := now.Sub(at); age > MaxAge || age < -2*time.Minute {
		return fmt.Errorf("status is %s old (the firewall timer stopped?)", age.Round(time.Second))
	}
	if s.EngineUID != engineUID {
		return fmt.Errorf("rules are for uid %d, the engine account is %d", s.EngineUID, engineUID)
	}
	if proxyPort > 0 && s.ProxyPort != proxyPort {
		return fmt.Errorf("rules allow port %d, the model proxy is %d", s.ProxyPort, proxyPort)
	}
	if s.Rules <= 0 {
		return fmt.Errorf("no rules")
	}
	return nil
}

// Write replaces path atomically (temp file in the same folder, O_EXCL|O_NOFOLLOW, 0644, rename).
func Write(path string, s *Status) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d.tmp", filepath.Base(path), time.Now().UnixNano()))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
