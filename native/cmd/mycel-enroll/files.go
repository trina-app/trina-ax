package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ---------- status file (substrate.ts EnrollStatusFile) ----------

type verifyResult struct {
	OK            bool    `json:"ok"`
	Files         int64   `json:"files"`
	Bytes         int64   `json:"bytes"`
	SchemaVersion *int64  `json:"schemaVersion"`
	Seconds       float64 `json:"seconds"`
}

type statusFile struct {
	V          int           `json:"v"`
	State      string        `json:"state"`
	Mode       string        `json:"mode"`
	Step       string        `json:"step"`
	At         string        `json:"at"`
	KitVersion *string       `json:"kitVersion"`
	Error      *statusError  `json:"error"`
	Verify     *verifyResult `json:"verify"`
}

type statusError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeStatus replaces the status file atomically (root 0644: no secrets in it). Failing to write it is not fatal.
func (e *Enroller) writeStatus(state, mode string, f *failure, v *verifyResult) {
	s := statusFile{V: 1, State: state, Mode: mode, Step: e.step, At: e.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Verify: v}
	if e.kitVersion != "" {
		k := e.kitVersion
		s.KitVersion = &k
	}
	if f != nil {
		msg := f.Msg
		if len(msg) > 500 {
			msg = msg[:497] + "…"
		}
		s.Error = &statusError{Code: f.Code, Message: msg}
	}
	if e.StatusHook != nil {
		e.StatusHook(s)
	}
	b, _ := json.Marshal(s)
	_ = os.MkdirAll(filepath.Dir(e.P.StatusFile), 0o755)
	_ = atomicWrite(e.P.StatusFile, append(b, '\n'), 0o644, nil)
}

// ---------- atomic writes ----------

// atomicWrite writes a temp file next to path with the final mode (and owner when chown is given), then renames it.
func atomicWrite(path string, data []byte, mode os.FileMode, chown func(string) error) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
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
	if chown != nil {
		if err := chown(tmp); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	ok = true
	return nil
}

func (e *Enroller) ownServer(p string) error { return e.Chown(p, e.srvUID, e.srvGID) }

// writeServerFile: a server-account secret file (0600 axserver).
func (e *Enroller) writeServerFile(path string, data []byte) error {
	if err := e.mkServerDir(filepath.Dir(path)); err != nil {
		return err
	}
	return atomicWrite(path, data, 0o600, e.ownServer)
}

// mkServerDir makes dir (0700, server account) when it is missing; an existing folder keeps its mode and owner (the
// kit installer set them).
func (e *Enroller) mkServerDir(dir string) error {
	if st, err := os.Lstat(dir); err == nil {
		if !st.IsDir() {
			return fmt.Errorf("%s is not a folder", dir)
		}
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return e.ownServer(dir)
}

// ---------- server.json ----------

// mergeServerJSON reads BASE/config/server.json (keeping every key it does not touch, numbers as written), lets edit
// change it and writes it back (0600 server account). Returns the listen port for messages.
func (e *Enroller) mergeServerJSON(edit func(map[string]any)) (int, error) {
	path := filepath.Join(e.P.Base, "config", "server.json")
	m := map[string]any{}
	if b, err := os.ReadFile(path); err == nil {
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.UseNumber()
		if err := dec.Decode(&m); err != nil {
			return 0, fail("apply_failed", "%s is not valid JSON: %v", path, err)
		}
		if m == nil {
			m = map[string]any{}
		}
	} else if !os.IsNotExist(err) {
		return 0, fail("apply_failed", "read %s: %v", path, err)
	}
	edit(m)
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return 0, fail("apply_failed", "server.json: %v", err)
	}
	if err := e.writeServerFile(path, append(b, '\n')); err != nil {
		return 0, fail("apply_failed", "write %s: %v", path, err)
	}
	port := 47820
	if l, ok := m["listen"].(map[string]any); ok {
		if n, ok := l["port"].(json.Number); ok {
			if v, err := strconv.Atoi(n.String()); err == nil && v > 0 {
				port = v
			}
		}
	}
	return port, nil
}

// objectAt returns m[key] as an object, replacing a missing or non-object value with a new one.
func objectAt(m map[string]any, key string) map[string]any {
	if o, ok := m[key].(map[string]any); ok {
		return o
	}
	o := map[string]any{}
	m[key] = o
	return o
}

func toAny(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

// ---------- /etc/default/mycel ----------

// writeDefaults sets the keys mycel-enroll owns in /etc/default/mycel (the server unit's EnvironmentFile,
// linux-runtime §3.2.3) and keeps every other line.
func (e *Enroller) writeDefaults() error {
	c := e.cfg
	set := map[string]string{
		"MYCEL_TEAM_TZ":                      c.TimeZone,
		"MYCEL_INSTALL_ID":                   c.TenantID,
		"MYCEL_BACKUP_WINDOW_START_MIN":      strconv.Itoa(c.BackupWindowStartMin),
		"MYCEL_MAINTENANCE_WINDOW_START_MIN": strconv.Itoa(c.MaintenanceWindowStartMin),
	}
	order := []string{"MYCEL_TEAM_TZ", "MYCEL_INSTALL_ID", "MYCEL_BACKUP_WINDOW_START_MIN", "MYCEL_MAINTENANCE_WINDOW_START_MIN"}
	var out []string
	if b, err := os.ReadFile(e.P.DefaultFile); err == nil {
		for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			k, _, found := strings.Cut(strings.TrimSpace(line), "=")
			if _, ours := set[strings.TrimSpace(k)]; found && ours {
				continue
			}
			if line != "" || len(out) > 0 {
				out = append(out, line)
			}
		}
	}
	for _, k := range order {
		out = append(out, k+"="+set[k])
	}
	if err := os.MkdirAll(filepath.Dir(e.P.DefaultFile), 0o755); err != nil {
		return fail("apply_failed", "%v", err)
	}
	if err := atomicWrite(e.P.DefaultFile, []byte(strings.Join(out, "\n")+"\n"), 0o644, nil); err != nil {
		return fail("apply_failed", "write %s: %v", e.P.DefaultFile, err)
	}
	return nil
}

// ---------- small helpers ----------

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func parseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("bad URL")
	}
	return u, nil
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
