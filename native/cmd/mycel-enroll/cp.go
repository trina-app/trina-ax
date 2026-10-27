package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// POST {controlPlane}/enroll (control-plane.md §3.5.2). The one-time enroll token authenticates; the CP answers with
// everything the tenant needs and invalidates the token.

type enrollRequest struct {
	V                int     `json:"v"`
	TenantID         string  `json:"tenantId"`
	EnrollToken      string  `json:"enrollToken"`
	Mode             string  `json:"mode"`
	RelayPublicKey   *string `json:"relayPublicKey"`
	RelayProof       any     `json:"relayProof"`
	OneTimeRecipient *string `json:"oneTimeRecipient"`
	KitVersion       string  `json:"kitVersion"`
	AppVersion       string  `json:"appVersion"`
}

type registerProof struct {
	Kind string `json:"kind"` // register
	TS   int64  `json:"ts"`
	Sig  string `json:"sig"`
}

type rotateProof struct {
	Kind        string `json:"kind"` // rotate
	RelayTeamID string `json:"relayTeamId"`
	Sig         string `json:"sig"`
}

type enrollResponse struct {
	V      int `json:"v"`
	Server *struct {
		Deployment string `json:"deployment"`
		Relay      *struct {
			URL      *string `json:"url"`
			TeamName *string `json:"teamName"`
		} `json:"relay"`
		PublicOrigins []string `json:"publicOrigins"`
		Engine        *struct {
			CredentialKinds *[]string `json:"credentialKinds"`
		} `json:"engine"`
	} `json:"server"`
	RelayRegistration json.RawMessage `json:"relayRegistration"`
	SetupToken        *string         `json:"setupToken"`
	Plan              json.RawMessage `json:"plan"`
	Notices           json.RawMessage `json:"notices"`
	Restore           *restoreInfo    `json:"restore"`
}

type restoreInfo struct {
	Chain []struct {
		BackupID string `json:"backupId"`
		Objects  []struct {
			Name   string `json:"name"`
			URL    string `json:"url"`
			Sha256 string `json:"sha256"`
			Size   int64  `json:"size"`
		} `json:"objects"`
	} `json:"chain"`
	IdentityAge       string          `json:"identityAge"`
	CredentialsKeyAge *string         `json:"credentialsKeyAge"`
	Expect            json.RawMessage `json:"expect"`
}

func (e *Enroller) enroll(relay *relayKey, oneTime *oneTimeIdentity) (*enrollResponse, error) {
	c := e.cfg
	req := enrollRequest{V: 1, TenantID: c.TenantID, EnrollToken: *c.EnrollToken, Mode: c.Mode, KitVersion: e.kitVersion, AppVersion: e.appVersion()}
	if relay != nil {
		pub := relay.pubB64
		req.RelayPublicKey = &pub
		switch c.Mode {
		case "new":
			ts := e.Now().UnixMilli()
			req.RelayProof = registerProof{Kind: "register", TS: ts, Sig: relay.signB64(registerSigningString(*c.TeamSlug, pub, ts))}
		case "restore":
			req.RelayProof = rotateProof{Kind: "rotate", RelayTeamID: *c.RelayTeamID, Sig: relay.signB64(keyRotationString(*c.RelayTeamID, pub))}
		}
	}
	if oneTime != nil {
		r := oneTime.recipient
		req.OneTimeRecipient = &r
	}
	body, _ := json.Marshal(req)
	url := strings.TrimRight(c.ControlPlane, "/") + "/enroll"

	deadline := e.Now().Add(e.RetryDeadline)
	backoff := time.Second
	for attempt := 1; ; attempt++ {
		resp, retry, err := e.postEnroll(url, body)
		if err == nil {
			return resp, nil
		}
		if !retry || e.Now().Add(backoff).After(deadline) {
			return nil, err
		}
		fmt.Fprintf(e.Out, "mycel-enroll: attempt %d: %v; retrying in %s\n", attempt, err, backoff)
		e.Sleep(backoff)
		if backoff *= 2; backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

// postEnroll: one attempt. retry = the failure is worth another try (network, 5xx, 429).
func (e *Enroller) postEnroll(url string, body []byte) (*enrollResponse, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, false, fail("enroll_failed", "request: %v", err)
	}
	hr.Header.Set("content-type", "application/json")
	res, err := e.HTTP.Do(hr)
	if err != nil {
		return nil, true, fail("enroll_unreachable", "control plane not reachable: %v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK {
		detail := ""
		var eb struct {
			Error *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &eb) == nil && eb.Error != nil {
			detail = ": " + eb.Error.Code + " " + eb.Error.Message
		}
		retry := res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests
		return nil, retry, fail("enroll_failed", "control plane answered %d%s", res.StatusCode, detail)
	}
	var r enrollResponse
	if err := json.Unmarshal(raw, &r); err != nil || r.V != 1 {
		return nil, false, fail("enroll_failed", "control plane answer is not an EnrollResponse v1")
	}
	return &r, false, nil
}

// apply writes what the CP sent (new and restore; verify never applies).
func (e *Enroller) apply(r *enrollResponse) error {
	c := e.cfg
	if r.Server == nil {
		return fail("enroll_failed", "control plane answer has no server settings")
	}
	if _, err := e.mergeServerJSON(func(m map[string]any) {
		m["deployment"] = "hosted"
		rel := objectAt(m, "relay")
		if r.Server.Relay == nil {
			rel["url"], rel["teamName"] = nil, nil
		} else {
			rel["url"], rel["teamName"] = strPtrAny(r.Server.Relay.URL), strPtrAny(r.Server.Relay.TeamName)
		}
		if r.Server.PublicOrigins != nil {
			m["publicOrigins"] = toAny(r.Server.PublicOrigins)
		}
		kinds := cloudCredentialKinds
		if r.Server.Engine != nil && r.Server.Engine.CredentialKinds != nil {
			kinds = *r.Server.Engine.CredentialKinds
		}
		eng := objectAt(m, "engine")
		eng["credentialKinds"] = toAny(kinds)
		// the hosted service always runs the team's AI connections behind the model proxy ("managed", credentials D18;
		// "subscription" / "proxy" are its older names). A kit seed without the key would otherwise start in local-login.
		eng["authMode"] = "managed"

	}); err != nil {
		return err
	}
	if err := e.writeDefaults(); err != nil {
		return err
	}
	if isJSONObject(r.RelayRegistration) {
		if err := e.writeServerFile(filepath.Join(e.P.Base, "data", "relay", "registration.json"), append(compactJSON(r.RelayRegistration), '\n')); err != nil {
			return fail("apply_failed", "registration.json: %v", err)
		}
	}
	if c.Mode == "new" {
		if r.SetupToken == nil || *r.SetupToken == "" || strings.ContainsAny(*r.SetupToken, "\r\n\t ") {
			return fail("enroll_failed", "control plane answer has no setup token")
		}
		if err := e.writeServerFile(filepath.Join(e.P.Base, "data", "setup-token"), []byte(*r.SetupToken+"\n")); err != nil {
			return fail("apply_failed", "setup-token: %v", err)
		}
	}
	if isJSONObject(r.Plan) {
		if err := e.mycelCtl("apply-plan", r.Plan); err != nil {
			return err
		}
	}
	if isJSONObject(r.Notices) {
		if err := e.mycelCtl("notices-set", r.Notices); err != nil {
			return err
		}
	}
	return nil
}

// mycelCtl runs BASE/root/mycel-ctl <cmd> --json with stdin (the kit's root tool owns plan.json / notices.json and
// their schemas, linux-runtime §3.6.5, control-plane §3.5.3).
func (e *Enroller) mycelCtl(cmd string, stdin []byte) error {
	ctl := filepath.Join(e.P.Base, "root", "mycel-ctl")
	if !exists(ctl) {
		return fail("kit_incomplete", "%s is missing", ctl)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := e.Run.Run(ctx, ctl, []string{cmd, "--json"}, compactJSON(stdin)); err != nil {
		return fail("apply_failed", "mycel-ctl %s: %v", cmd, err)
	}
	return nil
}

func isJSONObject(b json.RawMessage) bool {
	t := bytes.TrimSpace(b)
	return len(t) > 0 && t[0] == '{'
}

func compactJSON(b []byte) []byte {
	var out bytes.Buffer
	if json.Compact(&out, b) != nil {
		return b
	}
	return out.Bytes()
}

func strPtrAny(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// osRemoveAll is a seam for tests that want to see cleanup.
var osRemoveAll = os.RemoveAll
