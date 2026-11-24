// Fake wireproxy for host tests: understands -v, -n, -c <conf>, -i <addr>.
// Listens on the [Socks5] BindAddress (accepts and closes) and serves /metrics.
package main

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
)

func main() {
	var conf, info string
	test := false
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "-v":
			fmt.Println("wireproxy, version fake")
			return
		case "-n":
			test = true
		case "-c":
			i++
			conf = args[i]
		case "-i":
			i++
			info = args[i]
		}
	}
	data, err := os.ReadFile(conf)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var wg, bind string
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "WGConfig":
			wg = strings.Trim(strings.TrimSpace(v), "`") // go-ini raw string
		case "BindAddress":
			bind = strings.TrimSpace(v)
		}
	}
	body, err := os.ReadFile(wg)
	if err != nil || strings.Contains(string(body), "Endpoint = bad") {
		fmt.Fprintln(os.Stderr, "invalid config: bad endpoint")
		os.Exit(1)
	}
	if test {
		return
	}
	// Let the test see which config the tunnel was really started with.
	os.WriteFile(conf+".seen", body, 0o600)
	if info != "" {
		go http.ListenAndServe(info, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, "private_key=REDACTED\nendpoint=198.51.100.7:51820\nlast_handshake_time_sec=1700000000\nrx_bytes=1000\ntx_bytes=200\n")
		}))
	}
	ln, err := net.Listen("tcp", bind)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		c.Close()
	}
}
