package main

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const testConf = `[Interface]
PrivateKey = uCTIK+56CPyCvwJxmU5dBfuyJvPuSXAq1FzHdnIxe1Q=
Address = 10.8.1.2/32
DNS = 1.1.1.1
Jc = 4
S1 = 20
I1 = <b 0x504f5354><rc 8><t>

[Peer]
PublicKey = QP+A67Z2UBrMgvNIdHv8gPel5URWNLS4B3ZQ2hQIZlg=
AllowedIPs = 0.0.0.0/0
Endpoint = 198.51.100.7:51820
`

func setup(t *testing.T) {
	t.Helper()
	t.Setenv("AWG_BROWSER_HOME", t.TempDir())
	initPaths()
	if err := ensureDirs(); err != nil {
		t.Fatal(err)
	}
}

func vpnLink(t *testing.T, conf string) string {
	inner, _ := json.Marshal(map[string]any{
		"description": "Мой сервер",
		"containers": []any{map[string]any{
			"container": "amnezia-awg",
			"awg":       map[string]any{"last_config": mustJSON(map[string]string{"config": conf})},
		}},
	})
	var z bytes.Buffer
	w := zlib.NewWriter(&z)
	w.Write(inner)
	w.Close()
	blob := binary.BigEndian.AppendUint32(nil, uint32(len(inner)))
	return "vpn://" + base64.RawURLEncoding.EncodeToString(append(blob, z.Bytes()...))
}

func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestDescribeConf(t *testing.T) {
	info, err := describeConf(testConf)
	if err != nil {
		t.Fatal(err)
	}
	if info.Protocol != "AWG 2.0" || info.Endpoint != "198.51.100.7:51820" || info.Address != "10.8.1.2/32" {
		t.Fatalf("unexpected %+v", info)
	}
	if _, err := describeConf("[Interface]\nAddress = 1\n"); err == nil {
		t.Fatal("expected error for config without PrivateKey")
	}
	plain := strings.NewReplacer("Jc = 4\n", "", "S1 = 20\n", "", "I1 = <b 0x504f5354><rc 8><t>\n", "").Replace(testConf)
	if info, _ := describeConf(plain); info.Protocol != "WireGuard" {
		t.Fatalf("plain WireGuard detected as %s", info.Protocol)
	}
}

func TestSlugify(t *testing.T) {
	for in, want := range map[string]string{"Нидерланды #1": "niderlandy-1", "Тест NL": "test-nl", "!!!": "profile", "My-VPN_2": "my-vpn_2"} {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestProfilesLifecycle(t *testing.T) {
	setup(t)
	p, err := importProfile("Тест NL", testConf)
	if err != nil || p.ID != "test-nl" || p.Protocol != "AWG 2.0" {
		t.Fatalf("import: %+v %v", p, err)
	}
	p2, err := importProfile("", vpnLink(t, testConf))
	if err != nil || p2.Name != "Мой сервер" || p2.ID != "moy-server" {
		t.Fatalf("import vpn://: %+v %v", p2, err)
	}
	p3, _ := importProfile("Тест NL", testConf)
	if p3.ID != "test-nl-2" {
		t.Fatalf("duplicate id: %s", p3.ID)
	}
	if st, _ := os.Stat(filepath.Join(P.Profiles, "test-nl.conf")); st.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("profile is readable by others: %v", st.Mode())
	}
	if err := renameProfile("test-nl", "Амстердам"); err != nil {
		t.Fatal(err)
	}
	if err := deleteProfile("../etc"); err == nil {
		t.Fatal("path traversal accepted")
	}
	deleteProfile("test-nl-2")
	list, _ := listProfiles()
	if len(list) != 2 || list[1].Name != "Амстердам" {
		t.Fatalf("list: %+v", list)
	}
	if _, err := startTunnel("test-nl", 40800, 40801); err == nil || !strings.Contains(err.Error(), "wireproxy") {
		t.Fatalf("start without wireproxy: %v", err)
	}
}

func TestBadVpnLink(t *testing.T) {
	if _, _, err := decodeVpnLink("vpn://!!!"); err == nil {
		t.Fatal("expected error")
	}
	if _, _, err := decodeVpnLink(vpnLink(t, "[Interface]\nPrivateKey = $KEY\n")); err == nil || !strings.Contains(err.Error(), "шаблоны") {
		t.Fatalf("expected template error, got %v", err)
	}
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestTunnelWithFakeWireproxy runs start/status/stop against a fake wireproxy binary.
func TestTunnelWithFakeWireproxy(t *testing.T) {
	setup(t)
	bin := filepath.Join(P.Base, "bin", exeName("wireproxy"))
	build := exec.Command("go", "build", "-o", bin, "./testdata/fakewireproxy")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v\n%s", err, out)
	}
	if v := wireproxyVersion(); v != "wireproxy, version fake" {
		t.Fatalf("version: %v", v)
	}
	if _, err := importProfile("bad", strings.Replace(testConf, "198.51.100.7:51820", "bad", 1)); err == nil || !strings.Contains(err.Error(), "отклонил") {
		t.Fatalf("configtest should reject: %v", err)
	}
	p, err := importProfile("NL", testConf)
	if err != nil {
		t.Fatal(err)
	}
	port, info := freePort(t), freePort(t)
	st, err := startTunnel(p.ID, port, info)
	if err != nil {
		t.Fatalf("start: %v\nlog:\n%s", err, tailLog(20))
	}
	defer stopTunnel()
	if st["running"] != true || st["password"] == "" || st["port"] != port {
		t.Fatalf("state: %+v", st)
	}
	m := st["metrics"].(map[string]any)
	if m["rx"] != int64(1000) || m["handshake"] != int64(1700000000) {
		t.Fatalf("metrics: %+v", m)
	}
	again, err := startTunnel(p.ID, port, info)
	if err != nil || again["pid"] != st["pid"] {
		t.Fatalf("restart with same settings should reuse: %v %+v", err, again)
	}
	res := safeHandle(map[string]any{"cmd": "status"})
	if res["ok"] != true || res["state"].(map[string]any)["running"] != true {
		t.Fatalf("status: %+v", res)
	}
	stopTunnel()
	if wireproxyAlive(st["pid"].(int)) {
		t.Fatal("wireproxy still alive after stop")
	}
	if res := safeHandle(map[string]any{"cmd": "status"}); res["state"].(map[string]any)["running"] != false {
		t.Fatalf("status after stop: %+v", res)
	}
}

func TestProtocolFraming(t *testing.T) {
	var buf bytes.Buffer
	writeMessage(&buf, map[string]any{"cmd": "ping"})
	msg, err := readMessage(&buf)
	if err != nil || msg["cmd"] != "ping" {
		t.Fatalf("roundtrip: %v %v", msg, err)
	}
	if res := safeHandle(map[string]any{"cmd": "nope"}); res["ok"] != false {
		t.Fatal("unknown command accepted")
	}
}

func TestWithDNS(t *testing.T) {
	if out, changed := withDNS(testConf); changed || out != testConf {
		t.Fatal("config with DNS must stay untouched")
	}
	noDNS := strings.Replace(testConf, "DNS = 1.1.1.1\n", "", 1)
	out, changed := withDNS(noDNS)
	if !changed || !strings.Contains(out, "[Interface]\nDNS = "+defaultDNS+"\nPrivateKey") {
		t.Fatalf("DNS not added:\n%s", out)
	}
	info, _ := describeConf(noDNS)
	if !info.DNSDefault || info.DNS != defaultDNS {
		t.Fatalf("describe: %+v", info)
	}
}

func TestIniPath(t *testing.T) {
	got, err := iniPath("/home/Dev#1/a;b/x.conf")
	if err != nil || got != "`/home/Dev#1/a;b/x.conf`" {
		t.Fatalf("iniPath: %q %v", got, err)
	}
	if _, err := iniPath("/tmp/a`b"); err == nil {
		t.Fatal("backtick in path accepted")
	}
}

// A profile without DNS must run from a copy with the default DNS, in a data
// directory whose path contains "#" and ";".
func TestTunnelNoDNSAndOddPath(t *testing.T) {
	t.Setenv("AWG_BROWSER_HOME", filepath.Join(t.TempDir(), "Dev#1;x"))
	initPaths()
	if err := ensureDirs(); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(P.Base, "bin", exeName("wireproxy"))
	if out, err := exec.Command("go", "build", "-o", bin, "./testdata/fakewireproxy").CombinedOutput(); err != nil {
		t.Fatalf("build fake: %v\n%s", err, out)
	}
	p, err := importProfile("nodns", strings.Replace(testConf, "DNS = 1.1.1.1\n", "", 1))
	if err != nil {
		t.Fatal(err)
	}
	if !p.DNSDefault {
		t.Fatal("dnsDefault flag missing")
	}
	port, info := freePort(t), freePort(t)
	st, err := startTunnel(p.ID, port, info)
	if err != nil {
		t.Fatalf("start: %v\n%s", err, tailLog(20))
	}
	defer stopTunnel()
	seen, err := os.ReadFile(P.RunConf + ".seen")
	if err != nil || !strings.Contains(string(seen), "DNS = "+defaultDNS) {
		t.Fatalf("tunnel started without DNS: %v\n%s", err, seen)
	}
	// A different info port must restart the tunnel, not reuse it.
	st2, err := startTunnel(p.ID, port, freePort(t))
	if err != nil || st2["pid"] == st["pid"] {
		t.Fatalf("info port change ignored: %v", err)
	}
	if err := stopTunnel(); err != nil {
		t.Fatal(err)
	}
}
