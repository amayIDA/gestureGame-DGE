//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"runtime"
)

func minimizeConsole() {}
func restoreConsole()  {}

func findBrowser() string {
	candidates := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	for _, n := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"} {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
	}
	return ""
}

func installBrowser() error { return errors.New("automatic install is only supported on Windows") }

func cameraPresent() (bool, bool) { return false, false }

func openDefault(u string) {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("open", u).Start()
	} else {
		_ = exec.Command("xdg-open", u).Start()
	}
}
