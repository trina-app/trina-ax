package main

import "testing"

func TestValidVersion(t *testing.T) {
	for _, v := range []string{"0.1.0", "1.2.3-beta.1", "0.9.0-test.2", "2026.10.21+build_7"} {
		if !validVersion(v) {
			t.Errorf("%q should be a version", v)
		}
	}
	// state.json is written by the server account: a "previous" like ../../x must never become a path
	for _, v := range []string{"", ".", "..", "../x", "../../etc", "a/b", "/abs", "-x", ".hidden", "1.0\n"} {
		if validVersion(v) {
			t.Errorf("%q must not be accepted as a version", v)
		}
	}
}
