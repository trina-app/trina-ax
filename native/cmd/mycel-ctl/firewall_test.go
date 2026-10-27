package main

import (
	"net/netip"
	"os"
	"strings"
	"testing"
)

func TestRulesTextGolden(t *testing.T) {
	self := &FirewallConf{Format: 1, ID: "mycel", EngineUID: 990, ServerUID: 989, ProxyPort: 47821, ServerPort: 47820, Deployment: "self"}
	want, _ := os.ReadFile("testdata/rules-self.nft")
	// a self-install ignores private resolvers (nothing private is blocked)
	if got := rulesText(self, []netip.Addr{netip.MustParseAddr("10.20.0.1")}); got != string(want) {
		t.Fatalf("self rules:\n%s\nwant:\n%s", got, want)
	}
	hosted := *self
	hosted.Deployment, hosted.ServerAllowPrivate = "hosted", []string{"10.30.0.7/24"}
	want, _ = os.ReadFile("testdata/rules-hosted.nft")
	if got := rulesText(&hosted, privateResolvers("# x\nnameserver 10.20.0.1\nnameserver 127.0.0.53\nnameserver 169.254.169.253\nnameserver 8.8.8.8\n")); got != string(want) {
		t.Fatalf("hosted rules:\n%s\nwant:\n%s", got, want)
	}
}

func TestPrivateResolvers(t *testing.T) {
	got := privateResolvers("nameserver 192.168.1.1\nnameserver fd00::53\nnameserver fe80::1%eth0\nnameserver 1.1.1.1\nsearch x\n")
	if len(got) != 2 || got[0].String() != "192.168.1.1" || got[1].String() != "fd00::53" {
		t.Fatalf("%v", got)
	}
	c := &FirewallConf{Format: 1, ID: "t", EngineUID: 2, ServerUID: 3, ProxyPort: 4, ServerPort: 5, Deployment: "hosted"}
	if !strings.Contains(rulesText(c, got), "ip6 daddr fd00::53 meta l4proto { tcp, udp } th dport 53 accept") {
		t.Fatal("IPv6 resolver rule missing")
	}
}

func TestFirewallConfValidation(t *testing.T) {
	good := `{"format":1,"id":"mycel","engineUid":990,"serverUid":989,"proxyPort":47821,"serverPort":47820,"deployment":"self","serverAllowPrivate":[]}`
	if _, err := parseFirewallConf([]byte(good)); err != nil {
		t.Fatal(err)
	}
	for _, b := range []string{
		strings.Replace(good, `"engineUid":990`, `"engineUid":0`, 1),
		strings.Replace(good, `"engineUid":990`, `"engineUid":989`, 1),
		strings.Replace(good, `"engineUid":990`, `"engineUid":70000`, 1),
		strings.Replace(good, `"proxyPort":47821`, `"proxyPort":0`, 1),
		strings.Replace(good, `"proxyPort":47821`, `"proxyPort":65536`, 1),
		strings.Replace(good, `"deployment":"self"`, `"deployment":"cloud"`, 1),
		strings.Replace(good, `"id":"mycel"`, `"id":"My Cel"`, 1),
		strings.Replace(good, `"id":"mycel"`, `"id":"x;flush ruleset"`, 1),
		strings.Replace(good, `"serverAllowPrivate":[]`, `"serverAllowPrivate":["10.0.0.1; accept"]`, 1),
		strings.Replace(good, `"format":1`, `"format":2`, 1),
		strings.Replace(good, `}`, `,"extra":1}`, 1),
	} {
		if _, err := parseFirewallConf([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

func TestCheckTable(t *testing.T) {
	js, err := os.ReadFile("testdata/nft-list-hosted.json") // `nft -j list table inet mycel` of rules-hosted.nft (nft 1.1.3)
	if err != nil {
		t.Fatal(err)
	}
	c := &FirewallConf{Format: 1, ID: "mycel", EngineUID: 990, ServerUID: 989, ProxyPort: 47821, ServerPort: 47820, Deployment: "hosted"}
	f, err := checkTable(js, c)
	if err != nil {
		t.Fatal(err)
	}
	if f.rules != 10 || f.version != "1.1.3" {
		t.Fatalf("%+v", f)
	}
	other := *c
	other.EngineUID = 991
	if _, err := checkTable(js, &other); err == nil {
		t.Fatal("wrong engine uid accepted")
	}
	other = *c
	other.ProxyPort = 1
	if _, err := checkTable(js, &other); err == nil {
		t.Fatal("wrong proxy port accepted")
	}
	// a table where engine_out also accepts the server port is refused
	bad := strings.Replace(string(js), `"right": 47821`, `"right": 47820`, 1)
	if _, err := checkTable([]byte(bad), c); err == nil {
		t.Fatal("engine_out accepting another port passed")
	}
	if _, err := checkTable([]byte(`{"nftables":[]}`), c); err == nil {
		t.Fatal("empty table passed")
	}
}
