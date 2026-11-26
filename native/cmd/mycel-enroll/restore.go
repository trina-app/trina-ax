package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"filippo.io/age"
	"filippo.io/age/armor"
)

// Restore (mode restore: a team's offsite backup into this new VM) and the restore test (mode verify), control-plane
// §3.8.5. The CP never sends a secret in the clear: it re-encrypts the team's backup identity (and, for restore, the
// credentials.key escrow copy) to a ONE-TIME age recipient made here for this enroll. The backup objects come from
// presigned R2 URLs; each is checked (size, sha256 of the stored bytes), decrypted with the team identity into a
// staging folder owned by the server account, and handed to the server's admin CLI (`admin.js restore-artifacts`,
// SV-5), which applies the chain (DB checks, team folder) — the format of the archive is the server's business.

type oneTimeIdentity struct {
	id        *age.X25519Identity
	recipient string
}

func newOneTimeIdentity() (*oneTimeIdentity, error) {
	id, err := age.GenerateX25519Identity()
	if err != nil {
		return nil, err
	}
	return &oneTimeIdentity{id: id, recipient: id.Recipient().String()}, nil
}

// decryptAgeText opens an age file sent as text: ASCII armor ("-----BEGIN AGE ENCRYPTED FILE-----") or base64 of the
// binary format. At most 1 MiB of plaintext (keys and identities are tiny).
func decryptAgeText(s string, ids ...age.Identity) ([]byte, error) {
	var src io.Reader
	if strings.Contains(s, "-----BEGIN AGE ENCRYPTED FILE-----") {
		src = armor.NewReader(strings.NewReader(strings.TrimSpace(s) + "\n"))
	} else {
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
		if err != nil {
			return nil, fmt.Errorf("neither age armor nor base64")
		}
		src = bytes.NewReader(b)
	}
	r, err := age.Decrypt(src, ids...)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(r, 1<<20))
}

// teamIdentity decrypts identityAge (one-time recipient) into the team's backup identities.
func teamIdentity(ri *restoreInfo, ot *oneTimeIdentity) ([]age.Identity, error) {
	plain, err := decryptAgeText(ri.IdentityAge, ot.id)
	if err != nil {
		return nil, fmt.Errorf("identityAge: %v", err)
	}
	ids, err := age.ParseIdentities(bytes.NewReader(plain))
	if err != nil {
		return nil, fmt.Errorf("identityAge does not hold an age identity: %v", err)
	}
	return ids, nil
}

type chainEntry struct {
	BackupID string   `json:"backupId"`
	Files    []string `json:"files"`
}

// fetchChain downloads, checks and decrypts every object of the chain into staging/<backupId>/<name without .age>,
// writes staging/chain.json (order of application), gives everything to the server account. Returns file and byte counts.
func (e *Enroller) fetchChain(ri *restoreInfo, ids []age.Identity, staging string) (files, total int64, err error) {
	dl := filepath.Join(e.P.Base, ".install-tmp", "enroll-dl")
	if err := os.MkdirAll(dl, 0o700); err != nil {
		return 0, 0, fail("restore_failed", "%v", err)
	}
	defer osRemoveAll(dl)
	_ = osRemoveAll(staging)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return 0, 0, fail("restore_failed", "%v", err)
	}
	client := *e.HTTP
	client.Timeout = 0 // large objects: a per-object deadline below instead
	var chain []chainEntry
	for _, b := range ri.Chain {
		if !safeNameRE.MatchString(b.BackupID) {
			return 0, 0, fail("restore_failed", "bad backup id %q", b.BackupID)
		}
		entry := chainEntry{BackupID: b.BackupID}
		dir := filepath.Join(staging, b.BackupID)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return 0, 0, fail("restore_failed", "%v", err)
		}
		for _, o := range b.Objects {
			if !safeNameRE.MatchString(o.Name) || o.Size < 0 || len(o.Sha256) != 64 {
				return 0, 0, fail("restore_failed", "bad object entry %q", o.Name)
			}
			if err := e.checkURL(o.URL); err != nil {
				return 0, 0, err
			}
			enc := filepath.Join(dl, b.BackupID+"__"+o.Name)
			if err := download(&client, o.URL, enc, o.Size, o.Sha256); err != nil {
				return 0, 0, fail("restore_failed", "%s/%s: %v", b.BackupID, o.Name, err)
			}
			name := strings.TrimSuffix(o.Name, ".age")
			n, err := decryptFile(enc, filepath.Join(dir, name), ids)
			_ = os.Remove(enc)
			if err != nil {
				return 0, 0, fail("restore_failed", "decrypt %s/%s: %v", b.BackupID, o.Name, err)
			}
			entry.Files = append(entry.Files, name)
			files++
			total += n
		}
		chain = append(chain, entry)
	}
	cj, _ := json.MarshalIndent(map[string]any{"format": 1, "chain": chain}, "", "  ")
	if err := os.WriteFile(filepath.Join(staging, "chain.json"), append(cj, '\n'), 0o600); err != nil {
		return 0, 0, fail("restore_failed", "%v", err)
	}
	if err := filepath.WalkDir(staging, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return e.ownServer(p)
	}); err != nil {
		return 0, 0, fail("restore_failed", "chown staging: %v", err)
	}
	return files, total, nil
}

func download(c *http.Client, url, dst string, size int64, sha string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download answered %d", res.StatusCode)
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if n != size {
		return fmt.Errorf("size %d, expected %d", n, size)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != strings.ToLower(sha) {
		return fmt.Errorf("sha256 mismatch")
	}
	return nil
}

func decryptFile(src, dst string, ids []age.Identity) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	r, err := age.Decrypt(in, ids...)
	if err != nil {
		return 0, err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, r)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return n, err
}

// adminJS runs the server's admin CLI as the server account, with a fixed environment (linux-runtime §3.5.3 style).
func (e *Enroller) adminJS(args ...string) ([]byte, error) {
	bun := filepath.Join(e.P.Base, "app", "current", "bin", "bun")
	admin := filepath.Join(e.P.Base, "app", "current", "server", "src", "admin.js")
	if !exists(admin) || !exists(bun) {
		return nil, fail("restore_unsupported", "the installed app has no admin CLI (%s)", admin)
	}
	cmd := []string{"-u", e.P.ServerUser, "--", "env", "-i", "PATH=/usr/bin:/bin", "HOME=" + filepath.Join(e.P.Base, "data"),
		"MYCEL_CONFIG=" + filepath.Join(e.P.Base, "config", "server.json"), bun, admin}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()
	out, err := e.Run.Run(ctx, "runuser", append(cmd, args...), nil)
	if err != nil {
		if ce, ok := err.(*CmdError); ok && strings.Contains(strings.ToLower(ce.Stderr), "unknown command") {
			return out, fail("restore_unsupported", "admin.js %s is not available in this app version", args[0])
		}
		return out, fail("restore_failed", "admin.js %s: %v", args[0], err)
	}
	return out, nil
}

func (e *Enroller) restore(r *enrollResponse, ot *oneTimeIdentity) error {
	ri := r.Restore
	if ri == nil {
		return fail("enroll_failed", "mode restore but the answer has no restore section")
	}
	ids, err := teamIdentity(ri, ot)
	if err != nil {
		return fail("restore_failed", "%v", err)
	}
	staging := filepath.Join(e.P.Base, "data", ".restore-staging")
	defer osRemoveAll(staging)
	if _, _, err := e.fetchChain(ri, ids, staging); err != nil {
		return err
	}
	// restore-artifacts builds <out>/db/app.sqlite + <out>/team into a folder that must not exist yet (the same rule
	// as restore-verify; it ends sessions in the restored database). The folder is in dataDir. BASE itself is
	// root-owned: only this root process can put team/ in place.
	dataDir, teamRoot, err := e.serverDirs()
	if err != nil {
		return fail("restore_failed", "%v", err)
	}
	out := filepath.Join(dataDir, ".restore-out")
	clean := func() {
		_ = osRemoveAll(out)
		// restoreArtifacts builds in <out>.partial-<pid>: a crash there leaves it behind
		if m, _ := filepath.Glob(out + ".partial-*"); m != nil {
			for _, p := range m {
				_ = osRemoveAll(p)
			}
		}
	}
	clean()
	defer clean()
	if _, err := e.adminJS("restore-artifacts", "--dir", staging, "--to", out); err != nil {
		return err
	}
	if err := swapInRestored(out, dataDir, teamRoot, time.Now().UTC().Format("20060102T150405Z")); err != nil {
		return fail("restore_failed", "%v", err)
	}
	if ri.CredentialsKeyAge != nil && *ri.CredentialsKeyAge != "" {
		key, err := decryptAgeText(*ri.CredentialsKeyAge, ot.id)
		if err != nil {
			return fail("restore_failed", "credentialsKeyAge: %v", err)
		}
		name, line, err := credentialsKeyFile(key)
		if err != nil {
			return fail("restore_failed", "credentials.key: %v", err)
		}
		if err := e.writeServerFile(filepath.Join(e.P.Base, "secrets", name), []byte(line+"\n")); err != nil {
			return fail("restore_failed", "write %s: %v", name, err)
		}
	}
	return nil
}

var keyFileNameRE = regexp.MustCompile(`^credentials\.key(\.[0-9]{1,4})?$`)

// credentialsKeyFile: the escrow copy (admin.js credentials-escrow-out) is the key file's line; after a rekey (key
// version N > 1) it starts with the file name, "credentials.key.<N> <base64>", so the restored rows, encrypted under
// version N, find their key. Returns the file name under secrets/ and the line to write.
func credentialsKeyFile(b []byte) (string, string, error) {
	if f := strings.Fields(string(b)); len(f) == 2 {
		if !keyFileNameRE.MatchString(f[0]) {
			return "", "", fmt.Errorf("not a credentials key file name: %q", f[0])
		}
		line, err := credentialsKeyLine([]byte(f[1]))
		return f[0], line, err
	}
	line, err := credentialsKeyLine(b)
	return "credentials.key", line, err
}

// credentialsKeyLine: credentials.key is 32 random bytes written as one base64 line (credentials.md §key). The escrow
// copy may hold either form.
func credentialsKeyLine(b []byte) (string, error) {
	if len(b) == 32 {
		return base64.StdEncoding.EncodeToString(b), nil
	}
	t := strings.TrimSpace(string(b))
	if raw, err := base64.StdEncoding.DecodeString(t); err == nil && len(raw) == 32 {
		return t, nil
	}
	return "", fmt.Errorf("not a 32-byte key")
}

// verifyRestore (mode verify): restore into a scratch folder, let the server check it, report, start nothing.
func (e *Enroller) verifyRestore(r *enrollResponse, ot *oneTimeIdentity) (*verifyResult, error) {
	ri := r.Restore
	if ri == nil {
		return nil, fail("enroll_failed", "mode verify but the answer has no restore section")
	}
	t0 := e.Now()
	ids, err := teamIdentity(ri, ot)
	if err != nil {
		return nil, fail("verify_failed", "%v", err)
	}
	staging := filepath.Join(e.P.Base, "data", ".restore-verify")
	defer osRemoveAll(staging)
	files, total, err := e.fetchChain(ri, ids, staging)
	if err != nil {
		return nil, err
	}
	args := []string{"restore-verify", "--dir", staging}
	if len(bytes.TrimSpace(ri.Expect)) > 0 && string(bytes.TrimSpace(ri.Expect)) != "null" {
		args = append(args, "--expect", string(compactJSON(ri.Expect)))
	}
	out, err := e.adminJS(args...)
	res := &verifyResult{OK: err == nil, Files: files, Bytes: total}
	var rep struct {
		OK            *bool  `json:"ok"`
		Files         *int64 `json:"files"`
		Bytes         *int64 `json:"bytes"`
		SchemaVersion *int64 `json:"schemaVersion"`
	}
	if json.Unmarshal(bytes.TrimSpace(out), &rep) == nil {
		if rep.OK != nil {
			res.OK = res.OK && *rep.OK
		}
		if rep.Files != nil {
			res.Files = *rep.Files
		}
		if rep.Bytes != nil {
			res.Bytes = *rep.Bytes
		}
		res.SchemaVersion = rep.SchemaVersion
	}
	res.Seconds = e.Now().Sub(t0).Seconds()
	if err != nil {
		if f, ok := err.(*failure); ok && f.Code == "restore_unsupported" {
			return nil, err
		}
	}
	// a verify that ran but found a problem is still a finished enroll: the result carries ok=false
	return res, nil
}

// serverDirs: dataDir and teamRoot from BASE/config/server.json (apply has written it), else BASE/data and BASE/team.
// A server.json that is there but cannot be read is an error: the restore must not go to a guessed place.
func (e *Enroller) serverDirs() (string, string, error) {
	dataDir, teamRoot := filepath.Join(e.P.Base, "data"), filepath.Join(e.P.Base, "team")
	path := filepath.Join(e.P.Base, "config", "server.json")
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return dataDir, teamRoot, nil
	}
	if err != nil {
		return "", "", fmt.Errorf("read %s: %v", path, err)
	}
	var c struct {
		DataDir  string `json:"dataDir"`
		TeamRoot string `json:"teamRoot"`
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return "", "", fmt.Errorf("%s is not valid JSON: %v", path, err)
	}
	if filepath.IsAbs(c.DataDir) {
		dataDir = c.DataDir
	}
	if filepath.IsAbs(c.TeamRoot) {
		teamRoot = c.TeamRoot
	}
	return dataDir, teamRoot, nil
}

// swapInRestored puts <out>/db/app.sqlite in place of <dataDir>/app.db and <out>/team in place of teamRoot. What was
// there stays next to it as *.before-restore-<stamp>; the engine session stashes (data/sessions) of the replaced
// database are moved aside too. It is the office restore's swap (swapInRestore, server/src/office/cli.ts) without
// its endSessions (restore-artifacts did it) and setup token removal (restore mode writes no setup token). Runs before
// the units start: nothing has the database open. When the team folder cannot be put in place, the database swap is
// undone, so the VM never has a restored database with the old team folder.
func swapInRestored(out, dataDir, teamRoot, stamp string) error {
	incoming := filepath.Join(out, "db", "app.sqlite")
	inTeam := filepath.Join(out, "team")
	if !exists(incoming) || !exists(inTeam) {
		return fmt.Errorf("restore-artifacts left no db/app.sqlite or team/ in %s", out)
	}
	// a rename does not cross file systems: refuse before anything moves
	if ok, err := sameDevice(out, filepath.Dir(teamRoot)); err != nil || !ok {
		return fmt.Errorf("%s and %s are not on one file system (%v)", out, teamRoot, err)
	}
	db := filepath.Join(dataDir, "app.db")
	oldDb := db + ".before-restore-" + stamp
	hadDb := exists(db)
	if hadDb {
		if err := os.Rename(db, oldDb); err != nil {
			return fmt.Errorf("move the old database aside: %v", err)
		}
	}
	for _, sfx := range []string{"-wal", "-shm"} {
		_ = os.Remove(db + sfx)
	}
	if err := os.Rename(incoming, db); err != nil {
		return fmt.Errorf("put the restored database in place: %v", err)
	}
	if err := os.Chmod(db, 0o600); err != nil {
		return fmt.Errorf("chmod %s: %v", db, err)
	}
	undoDb := func() {
		_ = os.Remove(db)
		if hadDb {
			_ = os.Rename(oldDb, db)
		}
	}
	oldTeam := teamRoot + ".before-restore-" + stamp
	hadTeam := exists(teamRoot)
	if hadTeam {
		if err := os.Rename(teamRoot, oldTeam); err != nil {
			undoDb()
			return fmt.Errorf("move the old team folder aside: %v", err)
		}
	}
	if err := os.Rename(inTeam, teamRoot); err != nil {
		if hadTeam {
			_ = os.Rename(oldTeam, teamRoot)
		}
		undoDb()
		return fmt.Errorf("put the restored team folder in place: %v", err)
	}
	if err := os.Chmod(teamRoot, 0o700); err != nil {
		return fmt.Errorf("chmod %s: %v", teamRoot, err)
	}
	if stashes := filepath.Join(dataDir, "sessions"); exists(stashes) {
		_ = os.Rename(stashes, stashes+".before-restore-"+stamp)
	}
	return nil
}

// sameDevice: a and b are on one file system (rename works between them).
func sameDevice(a, b string) (bool, error) {
	sa, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	sb, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	da, okA := sa.Sys().(*syscall.Stat_t)
	db, okB := sb.Sys().(*syscall.Stat_t)
	if !okA || !okB {
		return true, nil
	}
	return da.Dev == db.Dev, nil
}
