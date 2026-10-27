package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"mycel/native/internal/fwstatus"
)

// FirewallConf is <base>/root/firewall.conf.json (root 0644, written by the installer).
type FirewallConf struct {
	Format             int      `json:"format"`
	ID                 string   `json:"id"`
	EngineUID          int      `json:"engineUid"`
	ServerUID          int      `json:"serverUid"`
	ProxyPort          int      `json:"proxyPort"`
	ServerPort         int      `json:"serverPort"`
	Deployment         string   `json:"deployment"`
	ServerAllowPrivate []string `json:"serverAllowPrivate"`
}

func parseFirewallConf(b []byte) (*FirewallConf, error) {
	var c FirewallConf
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("firewall.conf.json: %v", err)
	}
	if c.Format != 1 {
		return nil, fmt.Errorf("firewall.conf.json: format must be 1")
	}
	if !idRe.MatchString(c.ID) {
		return nil, fmt.Errorf("firewall.conf.json: bad id %q", c.ID)
	}
	for _, u := range []int{c.EngineUID, c.ServerUID} {
		if u < 1 || u > 65534 {
			return nil, fmt.Errorf("firewall.conf.json: uid %d outside 1-65534", u)
		}
	}
	if c.EngineUID == c.ServerUID {
		return nil, fmt.Errorf("firewall.conf.json: the engine and server accounts must differ")
	}
	for _, p := range []int{c.ProxyPort, c.ServerPort} {
		if p < 1 || p > 65535 {
			return nil, fmt.Errorf("firewall.conf.json: port %d outside 1-65535", p)
		}
	}
	if c.Deployment != "self" && c.Deployment != "hosted" {
		return nil, fmt.Errorf("firewall.conf.json: deployment must be self or hosted")
	}
	for _, p := range c.ServerAllowPrivate {
		if _, err := netip.ParsePrefix(p); err != nil {
			return nil, fmt.Errorf("firewall.conf.json: serverAllowPrivate %q is not a CIDR", p)
		}
	}
	return &c, nil
}

var (
	privV4 = []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("172.16.0.0/12"), netip.MustParsePrefix("192.168.0.0/16"), netip.MustParsePrefix("100.64.0.0/10")}
	privV6 = []netip.Prefix{netip.MustParsePrefix("fc00::/7"), netip.MustParsePrefix("fe80::/10")}
)

// privateResolvers returns the nameservers of resolv.conf in the private ranges the hosted server chain blocks: the
// server must still resolve names through them (spec 3.4.1). Loopback resolvers (systemd-resolved 127.0.0.53) are not
// blocked and need no rule; link-local ones (169.254/16) stay blocked with the metadata range.
func privateResolvers(resolvConf string) []netip.Addr {
	var out []netip.Addr
	sc := bufio.NewScanner(strings.NewReader(resolvConf))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 2 || f[0] != "nameserver" {
			continue
		}
		a, err := netip.ParseAddr(strings.SplitN(f[1], "%", 2)[0])
		if err != nil {
			continue
		}
		a = a.Unmap()
		for _, p := range append(append([]netip.Prefix{}, privV4...), privV6[0]) {
			if p.Contains(a) {
				out = append(out, a)
				break
			}
		}
	}
	return out
}

// rulesText is the whole nft transaction (spec 3.4.1). Every rule starts with `meta skuid X jump`: packets without a
// socket (kernel RST/ICMP/NDP) never match skuid, so they and every other account fall through to policy accept.
// The leading `table … {}` + `delete table …` makes the replace atomic even when the table does not exist yet.
func rulesText(c *FirewallConf, resolvers []netip.Addr) string {
	var b strings.Builder
	t := "inet " + c.ID
	fmt.Fprintf(&b, "table %s {}\ndelete table %s\ntable %s {\n", t, t, t)
	fmt.Fprintf(&b, "  chain output {\n    type filter hook output priority filter; policy accept;\n")
	fmt.Fprintf(&b, "    meta skuid %d jump engine_out\n    meta skuid %d jump server_out\n  }\n", c.EngineUID, c.ServerUID)
	fmt.Fprintf(&b, "  chain engine_out {\n")
	fmt.Fprintf(&b, "    oifname \"lo\" ip daddr 127.0.0.1 tcp dport %d accept\n", c.ProxyPort)
	fmt.Fprintf(&b, "    meta l4proto tcp counter reject with tcp reset\n")
	fmt.Fprintf(&b, "    counter reject with icmpx type admin-prohibited\n  }\n")
	fmt.Fprintf(&b, "  chain server_out {\n")
	fmt.Fprintf(&b, "    ip daddr 169.254.0.0/16 counter reject with icmpx type admin-prohibited\n")
	if c.Deployment == "hosted" {
		for _, r := range resolvers {
			fam := "ip"
			if r.Is6() {
				fam = "ip6"
			}
			fmt.Fprintf(&b, "    %s daddr %s meta l4proto { tcp, udp } th dport 53 accept\n", fam, r)
		}
	}
	for _, p := range c.ServerAllowPrivate {
		pp := netip.MustParsePrefix(p).Masked()
		fam := "ip"
		if pp.Addr().Is6() {
			fam = "ip6"
		}
		fmt.Fprintf(&b, "    %s daddr %s accept\n", fam, pp)
	}
	if c.Deployment == "hosted" {
		fmt.Fprintf(&b, "    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } counter reject with icmpx type admin-prohibited\n")
		fmt.Fprintf(&b, "    ip6 daddr { fc00::/7, fe80::/10 } counter reject with icmpx type admin-prohibited\n")
	}
	fmt.Fprintf(&b, "  }\n}\n")
	return b.String()
}

func cmdFirewall(e *env, args []string) (int, error) {
	pos, rest := positional(args)
	fs := flag.NewFlagSet("firewall", flag.ContinueOnError)
	e.flags(fs)
	if err := fs.Parse(rest); err != nil {
		return 2, usageError{err.Error()}
	}
	pos = append(pos, fs.Args()...)
	if len(pos) != 1 || (pos[0] != "apply" && pos[0] != "status" && pos[0] != "remove") {
		return 2, usageError{"firewall apply|status|remove"}
	}
	if err := requireRoot(); err != nil {
		return 2, err
	}
	if err := checkBase(e.base); err != nil {
		return 1, err
	}
	var st *fwstatus.Status
	var err error
	switch pos[0] {
	case "apply":
		st, err = firewallApply(e)
	case "status":
		st, err = firewallStatus(e)
	case "remove":
		return firewallRemove(e)
	}
	if st != nil {
		printJSON(e.stdout, st)
	}
	if err != nil || st == nil || !st.Loaded {
		if err == nil {
			err = fmt.Errorf("not loaded")
		}
		return 1, err
	}
	return 0, nil
}

func loadFirewallConf(e *env) (*FirewallConf, error) {
	b, err := readRootFile(e.root("firewall.conf.json"), 64<<10)
	if err != nil {
		return nil, err
	}
	return parseFirewallConf(b)
}

func (e *env) statusFile() string { return e.base + "/run/firewall.json" }

func failStatus(c *FirewallConf, now time.Time, msg string) *fwstatus.Status {
	s := &fwstatus.Status{Format: 1, At: now.UTC().Format(time.RFC3339Nano), Backend: "nftables", Loaded: false, Error: &msg}
	if c != nil {
		s.Table, s.EngineUID, s.ProxyPort = "inet "+c.ID, c.EngineUID, c.ProxyPort
	}
	return s
}

// firewallApply loads the table in one transaction, checks what the kernel now holds, and writes run/firewall.json.
func firewallApply(e *env) (*fwstatus.Status, error) {
	c, err := loadFirewallConf(e)
	if err != nil {
		s := failStatus(nil, e.now(), err.Error())
		_ = fwstatus.Write(e.statusFile(), s)
		return s, err
	}
	resolv, _ := os.ReadFile("/etc/resolv.conf")
	text := rulesText(c, privateResolvers(string(resolv)))
	if out, err := runNft(e, []byte(text), "-f", "-"); err != nil {
		s := failStatus(c, e.now(), "nft -f: "+strings.TrimSpace(out))
		_ = fwstatus.Write(e.statusFile(), s)
		return s, fmt.Errorf("%s", *s.Error)
	}
	return verifyAndRecord(e, c, text)
}

// firewallStatus re-checks the loaded table against the configuration and rewrites run/firewall.json.
func firewallStatus(e *env) (*fwstatus.Status, error) {
	c, err := loadFirewallConf(e)
	if err != nil {
		s := failStatus(nil, e.now(), err.Error())
		_ = fwstatus.Write(e.statusFile(), s)
		return s, err
	}
	resolv, _ := os.ReadFile("/etc/resolv.conf")
	return verifyAndRecord(e, c, rulesText(c, privateResolvers(string(resolv))))
}

func verifyAndRecord(e *env, c *FirewallConf, text string) (*fwstatus.Status, error) {
	out, err := runNft(e, nil, "-j", "list", "table", "inet", c.ID)
	var s *fwstatus.Status
	if err != nil {
		s = failStatus(c, e.now(), "nft list: "+strings.TrimSpace(out))
	} else if v, err := checkTable([]byte(out), c); err != nil {
		s = failStatus(c, e.now(), err.Error())
	} else {
		sum := sha256.Sum256([]byte(text))
		s = &fwstatus.Status{Format: 1, At: e.now().UTC().Format(time.RFC3339Nano), Backend: "nftables", Table: "inet " + c.ID, Loaded: true,
			Rules: v.rules, EngineUID: c.EngineUID, ProxyPort: c.ProxyPort, Sha256: hex.EncodeToString(sum[:]), NftVersion: v.version}
	}
	if werr := fwstatus.Write(e.statusFile(), s); werr != nil {
		return s, werr
	}
	if !s.Loaded {
		return s, fmt.Errorf("%s", *s.Error)
	}
	return s, nil
}

func firewallRemove(e *env) (int, error) {
	c, err := loadFirewallConf(e)
	if err != nil {
		return 1, err
	}
	if out, err := runNft(e, nil, "delete", "table", "inet", c.ID); err != nil && !strings.Contains(out, "No such file") {
		return 1, fmt.Errorf("nft delete: %s", strings.TrimSpace(out))
	}
	_ = os.Remove(e.statusFile())
	fmt.Fprintln(e.stdout, "removed table inet "+c.ID)
	return 0, nil
}

func runNft(e *env, stdin []byte, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, e.nft, args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C"}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

type tableFacts struct {
	rules   int
	version string
}

var nftVersionRe = regexp.MustCompile(`^[0-9][0-9.]*`)

// checkTable reads `nft -j list table inet <id>`: the output chain is a filter hook with policy accept, jumps the
// engine uid to engine_out, and engine_out accepts exactly the proxy port and ends in reject.
func checkTable(js []byte, c *FirewallConf) (tableFacts, error) {
	var doc struct {
		Nftables []map[string]json.RawMessage `json:"nftables"`
	}
	if err := json.Unmarshal(js, &doc); err != nil {
		return tableFacts{}, fmt.Errorf("nft -j: %v", err)
	}
	var f tableFacts
	type expr = map[string]json.RawMessage
	type rule struct {
		Chain string `json:"chain"`
		Table string `json:"table"`
		Expr  []expr `json:"expr"`
	}
	var outputHook, outputAccept bool
	var jumpEngine, acceptProxy, engineReject bool
	engineRules := 0
	for _, item := range doc.Nftables {
		if m, ok := item["metainfo"]; ok {
			var mi struct {
				Version string `json:"version"`
			}
			_ = json.Unmarshal(m, &mi)
			f.version = nftVersionRe.FindString(mi.Version)
		}
		if ch, ok := item["chain"]; ok {
			var cc struct {
				Name   string `json:"name"`
				Table  string `json:"table"`
				Type   string `json:"type"`
				Hook   string `json:"hook"`
				Policy string `json:"policy"`
			}
			_ = json.Unmarshal(ch, &cc)
			if cc.Table == c.ID && cc.Name == "output" {
				outputHook = cc.Type == "filter" && cc.Hook == "output"
				outputAccept = cc.Policy == "accept"
			}
		}
		r, ok := item["rule"]
		if !ok {
			continue
		}
		var rr rule
		if err := json.Unmarshal(r, &rr); err != nil || rr.Table != c.ID {
			continue
		}
		f.rules++
		s := string(r)
		switch rr.Chain {
		case "output":
			if matchSkuid(rr.Expr, c.EngineUID) && strings.Contains(s, `"jump"`) && strings.Contains(s, `"engine_out"`) {
				jumpEngine = true
			}
		case "engine_out":
			engineRules++
			if strings.Contains(s, `"accept"`) {
				if dport, ok := matchDport(rr.Expr); ok && dport == c.ProxyPort && strings.Contains(s, `"127.0.0.1"`) {
					acceptProxy = true
				} else {
					return f, fmt.Errorf("engine_out accepts something other than 127.0.0.1:%d", c.ProxyPort)
				}
			}
			if strings.Contains(s, `"reject"`) {
				engineReject = true
			}
		}
	}
	switch {
	case !outputHook || !outputAccept:
		return f, fmt.Errorf("table inet %s has no output filter chain with policy accept", c.ID)
	case !jumpEngine:
		return f, fmt.Errorf("output chain does not send uid %d to engine_out", c.EngineUID)
	case !acceptProxy:
		return f, fmt.Errorf("engine_out does not allow 127.0.0.1:%d", c.ProxyPort)
	case !engineReject || engineRules < 3:
		return f, fmt.Errorf("engine_out does not end in reject")
	}
	return f, nil
}

// matchSkuid: a `meta skuid == uid` match among the rule's expressions.
func matchSkuid(ex []map[string]json.RawMessage, uid int) bool {
	for _, x := range ex {
		m, ok := x["match"]
		if !ok {
			continue
		}
		var mm struct {
			Left struct {
				Meta struct {
					Key string `json:"key"`
				} `json:"meta"`
			} `json:"left"`
			Right json.RawMessage `json:"right"`
		}
		if json.Unmarshal(m, &mm) != nil || mm.Left.Meta.Key != "skuid" {
			continue
		}
		var n int
		if json.Unmarshal(mm.Right, &n) == nil && n == uid {
			return true
		}
	}
	return false
}

// matchDport: the tcp dport of a `tcp dport N` match.
func matchDport(ex []map[string]json.RawMessage) (int, bool) {
	for _, x := range ex {
		m, ok := x["match"]
		if !ok {
			continue
		}
		var mm struct {
			Left struct {
				Payload struct {
					Protocol string `json:"protocol"`
					Field    string `json:"field"`
				} `json:"payload"`
			} `json:"left"`
			Right json.RawMessage `json:"right"`
		}
		if json.Unmarshal(m, &mm) != nil || mm.Left.Payload.Field != "dport" || mm.Left.Payload.Protocol != "tcp" {
			continue
		}
		var n int
		if json.Unmarshal(mm.Right, &n) == nil {
			return n, true
		}
	}
	return 0, false
}
