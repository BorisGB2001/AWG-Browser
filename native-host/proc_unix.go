//go:build !windows

package main

import (
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func hideWindow(*exec.Cmd) {}

// startDetached runs wireproxy in its own session so it outlives the host
// process and is not hit by signals sent to Firefox's process group.
func startDetached(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd, cmd.Start()
}

// wireproxyAlive reports whether pid is a running wireproxy process (pids get reused).
func wireproxyAlive(pid int) bool {
	if pid <= 1 || syscall.Kill(pid, 0) != nil {
		return false
	}
	out, err := exec.Command("/bin/ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
	if err != nil {
		return false
	}
	return filepath.Base(strings.TrimSpace(string(out))) == "wireproxy"
}

func terminate(pid int) {
	syscall.Kill(pid, syscall.SIGTERM)
	for i := 0; i < 30; i++ {
		if !wireproxyAlive(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	syscall.Kill(pid, syscall.SIGKILL)
}
