// Native messaging host for the "Amnezia Browser Client" Firefox extension.
//
// Firefox talks to this program over stdin/stdout (native messaging protocol:
// 4-byte native-endian length + UTF-8 JSON). The host is stateless: Firefox
// starts a new process for every request. The tunnel itself is a detached
// wireproxy-awg process (userspace AmneziaWG -> local SOCKS5), tracked through
// run/state.json.
//
// Works on macOS, Windows and Linux; OS-specific process handling lives in
// proc_unix.go / proc_windows.go. No third-party dependencies.
package main

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const hostVersion = "2.1.0"

// defaultDNS is used when a profile has no DNS line. Without it wireproxy falls
// back to the system resolver and every site name leaks outside the tunnel.
const defaultDNS = "1.1.1.1, 1.0.0.1"

// hostError is an error whose text is shown to the user as is.
type hostError struct{ msg string }

func (e hostError) Error() string { return e.msg }

func userErr(format string, a ...any) error { return hostError{fmt.Sprintf(format, a...)} }

// ------------------------------------------------------------------ paths

type layout struct {
	Base, Profiles, Run, Logs, HostJSON, State, RunConf, LogFile string
}

var P layout

// dataDir returns the per-user data directory. On macOS the old name is kept so
// profiles imported by the first (Python) version keep working.
func dataDir() string {
	if d := os.Getenv("AWG_BROWSER_HOME"); d != "" { // tests / portable installs
		return d
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "AWG-Firefox")
	case "windows":
		if d := os.Getenv("LOCALAPPDATA"); d != "" {
			return filepath.Join(d, "AWG-Browser")
		}
		return filepath.Join(home, "AppData", "Local", "AWG-Browser")
	default:
		if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
			return filepath.Join(d, "awg-browser")
		}
		return filepath.Join(home, ".config", "awg-browser")
	}
}

func initPaths() {
	b := dataDir()
	P = layout{
		Base:     b,
		Profiles: filepath.Join(b, "profiles"),
		Run:      filepath.Join(b, "run"),
		Logs:     filepath.Join(b, "logs"),
		HostJSON: filepath.Join(b, "host.json"),
		State:    filepath.Join(b, "run", "state.json"),
		RunConf:  filepath.Join(b, "run", "wireproxy.conf"),
		LogFile:  filepath.Join(b, "logs", "wireproxy.log"),
	}
}

func ensureDirs() error {
	for _, d := range []string{P.Base, P.Profiles, P.Run, P.Logs} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// writePrivate writes a file readable only by the current user (on Windows the
// per-user LOCALAPPDATA ACL already restricts access).
func writePrivate(path string, data []byte) error {
	// A unique temp name: Firefox runs one host process per message, several may write at once.
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, 0o600)
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

func loadJSON(path string, v any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, v) == nil
}

func exeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func wireproxyPath() (string, error) {
	var hs struct {
		Wireproxy string `json:"wireproxy"`
	}
	loadJSON(P.HostJSON, &hs)
	path := hs.Wireproxy
	if path == "" {
		path = filepath.Join(P.Base, "bin", exeName("wireproxy"))
	}
	if st, err := os.Stat(path); err != nil || st.IsDir() {
		return "", userErr("Не найден wireproxy-awg (%s). Запустите установщик помощника.", path)
	}
	return path, nil
}

// ------------------------------------------------------------------ config parsing

type section map[string]string

var sectionRe = regexp.MustCompile(`^\[(\w+)\]$`)

// parseConf is a tiny INI reader for wg-quick style configs (keeps repeated sections).
func parseConf(text string) []section {
	var out []section
	var cur section
	for _, line := range strings.Split(text, "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if m := sectionRe.FindStringSubmatch(line); m != nil {
			cur = section{"_name": strings.ToLower(m[1])}
			out = append(out, cur)
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok && cur != nil {
			cur[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
		}
	}
	return out
}

type confInfo struct {
	Endpoint string `json:"endpoint"`
	Address  string `json:"address"`
	DNS      string `json:"dns"`
	Protocol string `json:"protocol"`
	// DNSDefault is true when the profile has no DNS line and defaultDNS is used.
	DNSDefault bool `json:"dnsDefault,omitempty"`
}

func hasAny(s section, keys ...string) bool {
	for _, k := range keys {
		if _, ok := s[k]; ok {
			return true
		}
	}
	return false
}

func describeConf(text string) (confInfo, error) {
	var iface section
	var peers []section
	for _, s := range parseConf(text) {
		switch s["_name"] {
		case "interface":
			if iface == nil {
				iface = s
			}
		case "peer":
			peers = append(peers, s)
		}
	}
	if iface == nil || iface["privatekey"] == "" {
		return confInfo{}, userErr("В конфиге нет секции [Interface] с PrivateKey.")
	}
	if iface["address"] == "" {
		return confInfo{}, userErr("В секции [Interface] нет Address.")
	}
	if len(peers) == 0 {
		return confInfo{}, userErr("В конфиге нет секции [Peer].")
	}
	for _, p := range peers {
		if p["publickey"] == "" || p["endpoint"] == "" {
			return confInfo{}, userErr("В секции [Peer] нужны PublicKey и Endpoint.")
		}
	}
	proto := "WireGuard"
	if hasAny(iface, "jc", "jmin", "jmax", "s1", "s2", "h1") {
		proto = "AWG 1.0"
	}
	if hasAny(iface, "s3", "s4", "i1") {
		proto = "AWG 2.0"
	}
	if hasAny(iface, "headerprotectionkey", "contentpaddingaddition") {
		proto = "AWG 3.0"
	}
	if hasAny(iface, "randomtrailers", "disablecookies") {
		proto = "AWG 3.1"
	}
	info := confInfo{Endpoint: peers[0]["endpoint"], Address: iface["address"], DNS: iface["dns"], Protocol: proto}
	if info.DNS == "" {
		info.DNS, info.DNSDefault = defaultDNS, true
	}
	return info, nil
}

var interfaceRe = regexp.MustCompile(`(?mi)^[ \t]*\[Interface\][ \t]*$`)

// withDNS returns the config with "DNS = defaultDNS" added to [Interface] when
// the profile has none, so that names are always resolved inside the tunnel.
func withDNS(text string) (string, bool) {
	for _, s := range parseConf(text) {
		if s["_name"] == "interface" && s["dns"] != "" {
			return text, false
		}
	}
	loc := interfaceRe.FindStringIndex(text)
	if loc == nil {
		return text, false
	}
	return text[:loc[1]] + "\nDNS = " + defaultDNS + text[loc[1]:], true
}

// decodeVpnLink decodes an Amnezia "vpn://..." share string into (config text, suggested name).
func decodeVpnLink(link string) (string, string, error) {
	payload := strings.Join(strings.Fields(strings.TrimPrefix(strings.TrimSpace(link), "vpn://")), "")
	payload = strings.TrimRight(payload, "=")
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		if raw, err = base64.RawStdEncoding.DecodeString(payload); err != nil {
			return "", "", userErr("Не удалось декодировать vpn:// (base64).")
		}
	}
	data := raw
	// Qt qCompress: 4-byte big-endian length + zlib stream
	for _, cand := range [][]byte{tail(raw, 4), raw} {
		if r, err := zlib.NewReader(bytes.NewReader(cand)); err == nil {
			if out, err := io.ReadAll(io.LimitReader(r, 4<<20)); err == nil { // vpn:// configs are a few KB
				data = out
				break
			}
		}
	}
	var obj map[string]any
	if json.Unmarshal(data, &obj) != nil {
		return "", "", userErr("vpn:// не содержит JSON-конфигурации Amnezia.")
	}
	name := "Amnezia"
	for _, k := range []string{"description", "name", "hostName"} {
		if s, ok := obj[k].(string); ok && s != "" {
			name = s
			break
		}
	}
	containers, _ := obj["containers"].([]any)
	for _, c := range containers {
		cm, _ := c.(map[string]any)
		keys := make([]string, 0, len(cm))
		for k := range cm {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v, ok := cm[k].(map[string]any)
			if !ok {
				continue
			}
			last := v["last_config"]
			if s, ok := last.(string); ok {
				var parsed map[string]any
				if json.Unmarshal([]byte(s), &parsed) != nil {
					continue
				}
				last = parsed
			}
			lm, _ := last.(map[string]any)
			conf, _ := lm["config"].(string)
			if strings.Contains(conf, "[Interface]") {
				if strings.Contains(conf, "$") {
					return "", "", userErr("Конфиг в vpn:// содержит незаполненные шаблоны ($...). Экспортируйте конфиг клиента AmneziaWG (.conf).")
				}
				return conf, name, nil
			}
		}
	}
	return "", "", userErr("В vpn:// нет конфигурации AmneziaWG/WireGuard. В приложении Amnezia выберите «Поделиться» → формат AmneziaWG.")
}

func tail(b []byte, n int) []byte {
	if len(b) < n {
		return nil
	}
	return b[n:]
}

// ------------------------------------------------------------------ profiles

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var slugRe = regexp.MustCompile(`[^a-z0-9_-]+`)

var translit = strings.NewReplacer(
	"а", "a", "б", "b", "в", "v", "г", "g", "д", "d", "е", "e", "ё", "e", "ж", "zh", "з", "z", "и", "i",
	"й", "y", "к", "k", "л", "l", "м", "m", "н", "n", "о", "o", "п", "p", "р", "r", "с", "s", "т", "t",
	"у", "u", "ф", "f", "х", "h", "ц", "ts", "ч", "ch", "ш", "sh", "щ", "sch", "ъ", "", "ы", "y", "ь", "",
	"э", "e", "ю", "yu", "я", "ya",
)

func slugify(name string) string {
	s := slugRe.ReplaceAllString(translit.Replace(strings.ToLower(name)), "-")
	s = strings.Trim(s, "-_")
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-_")
	}
	if s == "" {
		return "profile"
	}
	return s
}

func profilePath(id string) (string, error) {
	if !idRe.MatchString(id) {
		return "", userErr("Некорректный идентификатор профиля.")
	}
	return filepath.Join(P.Profiles, id+".conf"), nil
}

func metaPath(id string) string { return filepath.Join(P.Profiles, id+".json") }

type profile struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Error string `json:"error,omitempty"`
	confInfo
}

func profileName(id string) string {
	var meta struct {
		Name string `json:"name"`
	}
	if loadJSON(metaPath(id), &meta) && meta.Name != "" {
		return meta.Name
	}
	return id
}

func listProfiles() ([]profile, error) {
	entries, err := os.ReadDir(P.Profiles)
	if err != nil {
		return nil, err
	}
	out := []profile{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".conf")
		if !ok || !idRe.MatchString(id) {
			continue
		}
		p := profile{ID: id, Name: profileName(id)}
		if data, err := os.ReadFile(filepath.Join(P.Profiles, e.Name())); err != nil {
			p.Error = err.Error()
		} else if info, err := describeConf(string(data)); err != nil {
			p.Error = err.Error()
		} else {
			p.confInfo = info
		}
		out = append(out, p)
	}
	return out, nil
}

func saveMeta(id, name string) error {
	data, _ := json.Marshal(map[string]string{"name": name})
	return writePrivate(metaPath(id), data)
}

func importProfile(name, text string) (profile, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return profile{}, userErr("Пустой конфиг.")
	}
	if strings.HasPrefix(text, "vpn://") {
		conf, suggested, err := decodeVpnLink(text)
		if err != nil {
			return profile{}, err
		}
		text = conf
		if strings.TrimSpace(name) == "" {
			name = suggested
		}
	}
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n")) + "\n"
	info, err := describeConf(text)
	if err != nil {
		return profile{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		host, _, _ := strings.Cut(info.Endpoint, ":")
		name = host
	}
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	base := slugify(name)
	id := base
	var path string
	for n := 2; ; n++ {
		if path, err = profilePath(id); err != nil {
			return profile{}, err
		}
		// O_EXCL reserves the id: two imports running at once cannot take the same one.
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			f.Close()
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return profile{}, err
		}
		id = fmt.Sprintf("%s-%d", base, n)
	}
	if err := writePrivate(path, []byte(text)); err != nil {
		os.Remove(path)
		return profile{}, err
	}
	if err := saveMeta(id, name); err != nil {
		return profile{}, err
	}
	if err := configtest(path); err != nil {
		os.Remove(path)
		os.Remove(metaPath(id))
		return profile{}, err
	}
	return profile{ID: id, Name: name, confInfo: info}, nil
}

func deleteProfile(id string) error {
	path, err := profilePath(id)
	if err != nil {
		return err
	}
	var st tunnelState
	if loadJSON(P.State, &st) && st.Profile == id && wireproxyAlive(st.PID) {
		if err := stopTunnel(); err != nil {
			return err
		}
	}
	os.Remove(path)
	os.Remove(metaPath(id))
	return nil
}

func renameProfile(id, name string) error {
	path, err := profilePath(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return userErr("Профиль не найден.")
	}
	name = strings.TrimSpace(name)
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	if name == "" {
		return userErr("Пустое название.")
	}
	return saveMeta(id, name)
}

// ------------------------------------------------------------------ tunnel

type tunnelState struct {
	PID       int    `json:"pid"`
	Profile   string `json:"profile"`
	Port      int    `json:"port"`
	InfoPort  int    `json:"infoPort"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	StartedAt int64  `json:"startedAt"`
}

// iniPath makes a path safe for wireproxy's INI parser (go-ini): forward slashes
// (they work on Windows too, and a trailing backslash would mean "continued line")
// inside backticks, because an unquoted value is cut at the first "#" or ";".
func iniPath(p string) (string, error) {
	p = filepath.ToSlash(p)
	if strings.ContainsAny(p, "`\r\n") {
		return "", userErr("Путь к данным помощника содержит недопустимый символ: %s", p)
	}
	return "`" + p + "`", nil
}

func portOpen(port int, timeout time.Duration) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), timeout)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func configtest(profileFile string) error {
	bin, err := wireproxyPath()
	if err != nil {
		return nil // not installed yet: skip validation
	}
	quoted, err := iniPath(profileFile)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(P.Run, "configtest.*.conf")
	if err != nil {
		return err
	}
	tmp := f.Name()
	f.Close()
	defer os.Remove(tmp)
	if err := writePrivate(tmp, []byte("WGConfig = "+quoted+"\n")); err != nil {
		return err
	}
	cmd := exec.Command(bin, "-n", "-c", tmp)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := lastLine(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return userErr("wireproxy отклонил конфиг: %s", msg)
	}
	return nil
}

// stopTunnel stops the tracked wireproxy. The state file is removed only when the
// process is really gone: otherwise the tunnel would become untrackable and keep
// the ports busy forever.
func stopTunnel() error {
	var st tunnelState
	if loadJSON(P.State, &st) && wireproxyAlive(st.PID) {
		terminate(st.PID)
		if wireproxyAlive(st.PID) {
			return userErr("Не удалось остановить wireproxy (pid %d). Завершите процесс вручную.", st.PID)
		}
	}
	os.Remove(P.State)
	return nil
}

// trimLog keeps the wireproxy log from growing without limit (it is verbose).
func trimLog() {
	const limit, keep = 2 << 20, 256 << 10
	st, err := os.Stat(P.LogFile)
	if err != nil || st.Size() <= limit {
		return
	}
	data, err := os.ReadFile(P.LogFile)
	if err != nil {
		return
	}
	data = data[len(data)-keep:]
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		data = data[i+1:]
	}
	writePrivate(P.LogFile, data)
}

func randomPassword() string {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func startTunnel(id string, port, infoPort int) (map[string]any, error) {
	bin, err := wireproxyPath()
	if err != nil {
		return nil, err
	}
	path, err := profilePath(id)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); err != nil {
		return nil, userErr("Профиль не найден.")
	}
	if port < 1024 || port > 65535 || infoPort < 1024 || infoPort > 65535 || port == infoPort {
		return nil, userErr("Некорректные порты.")
	}

	var st tunnelState
	if loadJSON(P.State, &st) && wireproxyAlive(st.PID) && st.Profile == id && st.Port == port && st.InfoPort == infoPort && portOpen(port, 300*time.Millisecond) {
		return publicState(st), nil // already running with the same settings
	}
	if err := stopTunnel(); err != nil {
		return nil, err
	}
	for _, p := range []int{port, infoPort} {
		if portOpen(p, 300*time.Millisecond) {
			return nil, userErr("Порт 127.0.0.1:%d уже занят другой программой.", p)
		}
	}

	// Profiles without a DNS line run from a copy with the default DNS added.
	wgFile := path
	text, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if patched, changed := withDNS(string(text)); changed {
		wgFile = filepath.Join(P.Run, "profile.conf")
		if err := writePrivate(wgFile, []byte(patched)); err != nil {
			return nil, err
		}
	}
	quoted, err := iniPath(wgFile)
	if err != nil {
		return nil, err
	}

	st = tunnelState{Profile: id, Port: port, InfoPort: infoPort, Username: "awg", Password: randomPassword()}
	conf := fmt.Sprintf("WGConfig = %s\n\n[Socks5]\nBindAddress = 127.0.0.1:%d\nUsername = %s\nPassword = %s\n",
		quoted, port, st.Username, st.Password)
	if err := writePrivate(P.RunConf, []byte(conf)); err != nil {
		return nil, err
	}
	trimLog()
	logf, err := os.OpenFile(P.LogFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(logf, "\n==== %s start profile=%s port=%d\n", time.Now().Format("2006-01-02 15:04:05"), id, port)

	newCmd := func() *exec.Cmd {
		c := exec.Command(bin, "-c", P.RunConf, "-i", fmt.Sprintf("127.0.0.1:%d", infoPort))
		c.Stdout, c.Stderr = logf, logf
		return c
	}
	cmd, note, err := startDetached(newCmd)
	if note != "" {
		fmt.Fprintln(logf, "awg_host:", note)
	}
	logf.Close()
	if err != nil {
		return nil, userErr("Не удалось запустить wireproxy: %v", err)
	}
	exited := make(chan struct{})
	go func() { cmd.Wait(); close(exited) }()

	deadline := time.Now().Add(8 * time.Second)
	for !portOpen(port, 300*time.Millisecond) {
		select {
		case <-exited:
			return nil, userErr("wireproxy завершился при запуске: %s", tailLog(5))
		default:
		}
		if time.Now().After(deadline) {
			cmd.Process.Kill()
			return nil, userErr("wireproxy не открыл SOCKS-порт за 8 секунд.")
		}
		time.Sleep(150 * time.Millisecond)
	}
	st.PID = cmd.Process.Pid
	st.StartedAt = time.Now().Unix()
	data, _ := json.Marshal(st)
	if err := writePrivate(P.State, data); err != nil {
		return nil, err
	}
	return publicState(st), nil
}

func metrics(infoPort int) map[string]any {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/metrics", infoPort))
	if err != nil {
		return map[string]any{}
	}
	defer resp.Body.Close()
	var rx, tx, hs int64
	out := map[string]any{}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(v, 10, 64)
		switch k {
		case "rx_bytes":
			rx += n
		case "tx_bytes":
			tx += n
		case "last_handshake_time_sec":
			hs = max(hs, n)
		case "endpoint":
			out["endpoint"] = v
		}
	}
	out["rx"], out["tx"], out["handshake"] = rx, tx, hs
	return out
}

func publicState(st tunnelState) map[string]any {
	if !wireproxyAlive(st.PID) {
		return map[string]any{"running": false}
	}
	return map[string]any{
		"running": true, "profile": st.Profile, "port": st.Port, "infoPort": st.InfoPort, "username": st.Username,
		"password": st.Password, "startedAt": st.StartedAt, "pid": st.PID, "metrics": metrics(st.InfoPort),
	}
}

func tailLog(lines int) string {
	f, err := os.Open(P.LogFile)
	if err != nil {
		return ""
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > 64*1024 {
		f.Seek(st.Size()-64*1024, io.SeekStart)
	}
	data, _ := io.ReadAll(f)
	all := strings.Split(strings.TrimRight(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n"), "\n")
	if len(all) > lines {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n")
}

func wireproxyVersion() any {
	bin, err := wireproxyPath()
	if err != nil {
		return nil
	}
	cmd := exec.Command(bin, "-v")
	hideWindow(cmd)
	out, _ := cmd.CombinedOutput()
	if s := strings.TrimSpace(string(out)); s != "" {
		return s
	}
	return nil
}

// ------------------------------------------------------------------ dispatch

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func num(m map[string]any, k string, def int) int {
	switch v := m[k].(type) {
	case float64:
		return int(v)
	case string:
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func handle(msg map[string]any) (map[string]any, error) {
	switch cmd := str(msg, "cmd"); cmd {
	case "ping":
		return map[string]any{"version": hostVersion, "wireproxy": wireproxyVersion(), "dataDir": P.Base, "os": runtime.GOOS}, nil
	case "list":
		ps, err := listProfiles()
		return map[string]any{"profiles": ps}, err
	case "import":
		p, err := importProfile(str(msg, "name"), str(msg, "text"))
		return map[string]any{"profile": p}, err
	case "delete":
		return map[string]any{}, deleteProfile(str(msg, "id"))
	case "rename":
		return map[string]any{}, renameProfile(str(msg, "id"), str(msg, "name"))
	case "start":
		st, err := startTunnel(str(msg, "id"), num(msg, "port", 40800), num(msg, "infoPort", 40801))
		return map[string]any{"state": st}, err
	case "stop":
		return map[string]any{}, stopTunnel()
	case "status":
		var st tunnelState
		loadJSON(P.State, &st)
		return map[string]any{"state": publicState(st)}, nil
	case "logs":
		return map[string]any{"log": tailLog(num(msg, "lines", 80))}, nil
	default:
		return nil, userErr("Неизвестная команда: %q", cmd)
	}
}

func readMessage(r io.Reader) (map[string]any, error) {
	var n uint32
	if err := binary.Read(r, binary.NativeEndian, &n); err != nil {
		return nil, err
	}
	if n > 16<<20 {
		return nil, errors.New("message too large")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(buf, &m); err != nil {
		return map[string]any{}, nil // reported as unknown command
	}
	return m, nil
}

func writeMessage(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := binary.Write(w, binary.NativeEndian, uint32(len(data))); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func safeHandle(msg map[string]any) (res map[string]any) {
	defer func() {
		if r := recover(); r != nil {
			res = map[string]any{"ok": false, "error": fmt.Sprintf("внутренняя ошибка: %v", r)}
		}
	}()
	out, err := handle(msg)
	if err != nil {
		var he hostError
		if errors.As(err, &he) {
			return map[string]any{"ok": false, "error": he.msg}
		}
		return map[string]any{"ok": false, "error": err.Error()}
	}
	if out == nil {
		out = map[string]any{}
	}
	out["ok"] = true
	return out
}

func main() {
	initPaths()
	if len(os.Args) > 1 {
		// Command-line helpers for the installers; Firefox always runs the host
		// with the manifest path / extension id as arguments, never these flags.
		switch os.Args[1] {
		case "--version":
			fmt.Println("awg_host", hostVersion, runtime.GOOS+"/"+runtime.GOARCH)
			return
		case "--self-test":
			ensureDirs()
			res := safeHandle(map[string]any{"cmd": "ping"})
			out, _ := json.Marshal(res)
			fmt.Println(string(out))
			if res["ok"] != true || res["wireproxy"] == nil {
				os.Exit(1)
			}
			return
		case "--stop":
			if err := stopTunnel(); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			return
		}
	}
	if err := ensureDirs(); err != nil {
		writeMessage(os.Stdout, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	in := bufio.NewReader(os.Stdin)
	for {
		msg, err := readMessage(in)
		if err != nil {
			return // stdin closed by Firefox
		}
		if writeMessage(os.Stdout, safeHandle(msg)) != nil {
			return
		}
	}
}
