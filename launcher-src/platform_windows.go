//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	user32           = syscall.NewLazyDLL("user32.dll")
	getConsoleWindow = kernel32.NewProc("GetConsoleWindow")
	setConsoleTitle  = kernel32.NewProc("SetConsoleTitleW")
	setConsoleCP     = kernel32.NewProc("SetConsoleOutputCP")
	showWindow       = user32.NewProc("ShowWindow")
)

func init() {
	setConsoleCP.Call(65001) // UTF-8 so ✓ and … print correctly
	if p, err := syscall.UTF16PtrFromString(appName); err == nil {
		setConsoleTitle.Call(uintptr(unsafe.Pointer(p)))
	}
}

func minimizeConsole() {
	if h, _, _ := getConsoleWindow.Call(); h != 0 {
		showWindow.Call(h, 6) // SW_MINIMIZE
	}
}

func restoreConsole() {
	if h, _, _ := getConsoleWindow.Call(); h != 0 {
		showWindow.Call(h, 9) // SW_RESTORE
	}
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return cmd
}

// Chrome first (best WebGL/MediaPipe support), then Edge (preinstalled on Windows 10/11).
func findBrowser() string {
	roots := []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA"), `C:\Program Files`, `C:\Program Files (x86)`}
	for _, rel := range []string{`Google\Chrome\Application\chrome.exe`, `Microsoft\Edge\Application\msedge.exe`} {
		for _, r := range roots {
			if r == "" {
				continue
			}
			p := filepath.Join(r, rel)
			if fileExists(p) {
				return p
			}
		}
	}
	for _, exe := range []string{"chrome.exe", "msedge.exe"} {
		for _, hive := range []string{"HKLM", "HKCU"} {
			out, err := hidden(exec.Command("reg", "query", hive+`\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`+exe, "/ve")).Output()
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(out), "\n") {
				if i := strings.Index(line, "REG_SZ"); i >= 0 {
					p := strings.Trim(strings.TrimSpace(line[i+6:]), `"`)
					if fileExists(p) {
						return p
					}
				}
			}
		}
	}
	return ""
}

func installBrowser() error {
	// 1) winget (Windows 10 1809+ / 11)
	if wg, err := exec.LookPath("winget"); err == nil {
		say("  trying winget…")
		cmd := exec.Command(wg, "install", "-e", "--id", "Google.Chrome", "--silent",
			"--accept-package-agreements", "--accept-source-agreements")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		_ = cmd.Run()
		if findBrowser() != "" {
			return nil
		}
	}
	// 2) Google's official online installer
	say("  downloading Chrome installer from google.com…")
	dest := filepath.Join(os.TempDir(), "chrome_installer.exe")
	if err := download("https://dl.google.com/chrome/install/latest/chrome_installer.exe", dest); err != nil {
		return fmt.Errorf("download: %w (is the PC online?)", err)
	}
	say("  installing (approve the Windows prompt if one appears)…")
	if err := exec.Command(dest, "/silent", "/install").Run(); err != nil {
		say("  installer reported: %v", err)
	}
	for i := 0; i < 90 && findBrowser() == ""; i++ {
		time.Sleep(2 * time.Second)
	}
	if findBrowser() == "" {
		return fmt.Errorf("Chrome did not appear after install")
	}
	return nil
}

func cameraPresent() (ok bool, known bool) {
	ps := `(@(Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -in 'Camera','Image' -and $_.Status -eq 'OK' })).Count`
	cmd := hidden(exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps))
	done := make(chan []byte, 1)
	go func() { out, _ := cmd.Output(); done <- out }()
	select {
	case out := <-done:
		s := strings.TrimSpace(string(out))
		if s == "" {
			return false, false
		}
		return s != "0", true
	case <-time.After(10 * time.Second):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		return false, false
	}
}

func openDefault(u string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
