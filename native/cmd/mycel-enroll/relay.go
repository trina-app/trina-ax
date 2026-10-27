package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// The relay team key: Ed25519, PKCS#8 PEM in <data>/relay/team-key.pem (0600, server account) — the file the server
// already uses (server/src/relay-client/registration.ts loadOrCreateKey). Public key = SPKI DER, base64
// (shared/src/relay-protocol/keys.ts publicKeyOf). It is made here, in the VM: the private key never leaves it.

type relayKey struct {
	priv   ed25519.PrivateKey
	pubB64 string
}

func (e *Enroller) relayKey() (*relayKey, error) {
	dir := filepath.Join(e.P.Base, "data", "relay")
	file := filepath.Join(dir, "team-key.pem")
	if b, err := os.ReadFile(file); err == nil {
		k, err := parseRelayKey(b)
		if err != nil {
			return nil, fail("relay_key_failed", "%s: %v", file, err)
		}
		return k, nil
	} else if !os.IsNotExist(err) {
		return nil, fail("relay_key_failed", "read %s: %v", file, err)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fail("relay_key_failed", "generate: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, fail("relay_key_failed", "encode: %v", err)
	}
	if err := e.writeServerFile(file, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})); err != nil {
		return nil, fail("relay_key_failed", "write %s: %v", file, err)
	}
	return newRelayKey(priv)
}

func parseRelayKey(b []byte) (*relayKey, error) {
	blk, _ := pem.Decode(b)
	if blk == nil || blk.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("not a PKCS#8 PEM key")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, err
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("team key must be Ed25519")
	}
	return newRelayKey(priv)
}

func newRelayKey(priv ed25519.PrivateKey) (*relayKey, error) {
	spki, err := x509.MarshalPKIXPublicKey(priv.Public())
	if err != nil {
		return nil, err
	}
	return &relayKey{priv: priv, pubB64: base64.StdEncoding.EncodeToString(spki)}, nil
}

func (k *relayKey) signB64(msg string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(k.priv, []byte(msg)))
}

// Signing strings of shared/src/relay-protocol/registry-api.ts (registerSigningString, keyRotationString).
func registerSigningString(name, publicKey string, ts int64) string {
	return "mycel-relay-register\n" + name + "\n" + publicKey + "\n" + strconv.FormatInt(ts, 10)
}

func keyRotationString(teamID, publicKey string) string {
	return "mycel-relay-rotate\n" + teamID + "\n" + publicKey
}

func mkdirRoot(dir string) error {
	if st, err := os.Stat(dir); err == nil {
		if !st.IsDir() {
			return fmt.Errorf("%s is not a folder", dir)
		}
		return nil
	}
	return os.MkdirAll(dir, 0o755)
}
