package peer

import "testing"

func TestParseStat(t *testing.T) {
	for _, c := range []struct {
		name     string
		line     string
		wantPpid int
		wantSid  int
		wantOk   bool
	}{
		{
			name:     "normal stat line",
			line:     "42 (bash) S 10 42 42 0 -1 4194304 100 0 0 0",
			wantPpid: 10,
			wantSid:  42,
			wantOk:   true,
		},
		{
			name:     "command with spaces and closing paren",
			line:     "123 (we)ird name) S 1 2 3 0",
			wantPpid: 1,
			wantSid:  3,
			wantOk:   true,
		},
		{
			name:   "empty line",
			line:   "",
			wantOk: false,
		},
		{
			name:   "short input without paren",
			line:   "12",
			wantOk: false,
		},
		{
			name:   "truncated right after paren",
			line:   "12 (cmd)",
			wantOk: false,
		},
		{
			name:   "too few fields after state",
			line:   "12 (cmd) S 1 2",
			wantOk: false,
		},
		{
			name:   "non-numeric ppid",
			line:   "12 (cmd) S bad 2 3",
			wantOk: false,
		},
		{
			name:   "non-numeric sid",
			line:   "12 (cmd) S 1 2 bad",
			wantOk: false,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			ppid, sid, ok := parseStat(c.line)
			if ok != c.wantOk || ppid != c.wantPpid || sid != c.wantSid {
				t.Errorf("parseStat(%q) = (%d, %d, %v), want (%d, %d, %v)",
					c.line, ppid, sid, ok, c.wantPpid, c.wantSid, c.wantOk)
			}
		})
	}
}

func TestFindInode(t *testing.T) {
	tcpTable := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 12345 1 00000000 20 4 30 10 -1\n" +
		"   1: 0100007F:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999\n" +
		"   2: short row\n"

	tcp6Table := "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
		"   0: 00000000000000000000000001000000:D431 00000000000000000000000001000000:20FB 01 00000000:00000000 00:00000000 00000000  1000        0 54321 1 00000000\n"

	for _, c := range []struct {
		name       string
		table      string
		clientPort int
		serverPort int
		wantInode  string
		wantOk     bool
	}{
		{
			name:       "tcp matching row",
			table:      tcpTable,
			clientPort: 50000, // 0xC350
			serverPort: 8080,  // 0x1F90
			wantInode:  "12345",
			wantOk:     true,
		},
		{
			name:       "tcp non-matching ports",
			table:      tcpTable,
			clientPort: 50000,
			serverPort: 9000,
			wantOk:     false,
		},
		{
			name:       "tcp6 matching row",
			table:      tcp6Table,
			clientPort: 54321, // 0xD431
			serverPort: 8443,  // 0x20FB
			wantInode:  "54321",
			wantOk:     true,
		},
		{
			name:       "empty table",
			table:      "",
			clientPort: 50000,
			serverPort: 8080,
			wantOk:     false,
		},
		{
			name:       "header only",
			table:      "  sl  local_address rem_address\n",
			clientPort: 50000,
			serverPort: 8080,
			wantOk:     false,
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			inode, ok := findInode(c.table, c.clientPort, c.serverPort)
			if ok != c.wantOk || inode != c.wantInode {
				t.Errorf("findInode(%d, %d) = (%q, %v), want (%q, %v)",
					c.clientPort, c.serverPort, inode, ok, c.wantInode, c.wantOk)
			}
		})
	}
}
