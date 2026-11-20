//go:build windows

package main

import (
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	createNoWindow          = 0x08000000
	createNewProcessGroup   = 0x00000200
	detachedProcess         = 0x00000008
	createBreakawayFromJob  = 0x01000000
	processQueryLimitedInfo = 0x1000
	processTerminate        = 0x0001
	synchronize             = 0x00100000
	stillActive             = 259
)

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procQueryFullProcessImage = kernel32.NewProc("QueryFullProcessImageNameW")
)

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// startDetached starts wireproxy without a console window and outside Firefox's
// job object (Firefox kills the job of a native host when it is done with it).
// If the job does not allow breakaway, it falls back to a plain detached start.
func startDetached(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	base := uint32(createNoWindow | createNewProcessGroup | detachedProcess)
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: base | createBreakawayFromJob}
	if err := cmd.Start(); err == nil {
		return cmd, nil
	}
	cmd = newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: base}
	return cmd, cmd.Start()
}

func imageName(h syscall.Handle) string {
	buf := make([]uint16, 1024)
	size := uint32(len(buf))
	r, _, _ := procQueryFullProcessImage.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

// wireproxyAlive reports whether pid is a running wireproxy.exe (pids get reused).
// Note: never use os.Process.Signal(0)/os.Kill to probe on Windows — that terminates.
func wireproxyAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := syscall.OpenProcess(processQueryLimitedInfo, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if syscall.GetExitCodeProcess(h, &code) != nil || code != stillActive {
		return false
	}
	name := strings.ToLower(filepath.Base(imageName(h)))
	return name == "wireproxy.exe"
}

func terminate(pid int) {
	h, err := syscall.OpenProcess(processTerminate|synchronize, false, uint32(pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(h)
	syscall.TerminateProcess(h, 0)
	syscall.WaitForSingleObject(h, 3000)
}
