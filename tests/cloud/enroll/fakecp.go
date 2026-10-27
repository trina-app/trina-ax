// Fake control plane for tests/cloud/enroll-docker.sh: POST /enroll only (control-plane.md §3.5.2), standard library
// only so it builds outside any module (`go build fakecp.go`). It checks the one-time token (a second use gets 401, as
// the real CP does) and the relay register proof (Ed25519 over registerSigningString with the SPKI key the VM sent).
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
)

func main() {
	addr := flag.String("listen", "127.0.0.1:18080", "listen address")
	token := flag.String("token", "", "the one valid enroll token")
	reqLog := flag.String("log", "/tmp/fakecp-requests.jsonl", "append every request body here")
	flag.Parse()
	var mu sync.Mutex
	used := false
	http.HandleFunc("/enroll", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", 405)
			return
		}
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", 400)
			return
		}
		b, _ := json.Marshal(req)
		if f, err := os.OpenFile(*reqLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
			f.Write(append(b, '\n'))
			f.Close()
		}
		mu.Lock()
		ok := !used && req["enrollToken"] == *token
		used = used || ok
		mu.Unlock()
		if !ok {
			w.WriteHeader(401)
			fmt.Fprint(w, `{"error":{"code":"token_invalid","message":"enroll token unknown or already used"}}`)
			return
		}
		pub, _ := req["relayPublicKey"].(string)
		proof, _ := req["relayProof"].(map[string]any)
		spki, _ := base64.StdEncoding.DecodeString(pub)
		pk, err := x509.ParsePKIXPublicKey(spki)
		sig, _ := base64.StdEncoding.DecodeString(fmt.Sprint(proof["sig"]))
		msg := fmt.Sprintf("mycel-relay-register\n%s\n%s\n%d", "acme", pub, int64(proof["ts"].(float64)))
		if edk, isEd := pk.(ed25519.PublicKey); err != nil || !isEd || !ed25519.Verify(edk, []byte(msg), sig) {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":{"code":"bad_proof","message":"relay proof does not verify"}}`)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"v": 1,
			"server": map[string]any{"deployment": "hosted", "relay": map[string]any{"url": "wss://relay.treesoop.com/connect", "teamName": "acme"},
				"publicOrigins": []string{"https://acme.treesoop.com"}, "engine": map[string]any{}},
			"relayRegistration": map[string]any{"relayApi": "https://relay.treesoop.com", "teamId": "team_1", "teamName": "acme", "publicKey": pub, "address": "https://acme.treesoop.com"},
			"setupToken":        "stp_dockertest_0123456789abcdef",
			"plan":              map[string]any{"format": 1, "planId": "basic", "maxConcurrency": 2},
			"notices":           map[string]any{"format": 1, "notices": []any{}},
			"restore":           nil,
		})
	})
	log.Printf("fake CP on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
