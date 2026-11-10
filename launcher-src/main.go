// Catch the Target — self-contained launcher.
//
// One file to copy to any PC. It:
//  1. serves the whole game (embedded inside this .exe) on http://127.0.0.1
//  2. finds Chrome or Edge — and installs Chrome automatically if neither exists
//  3. warns if no webcam is connected
//  4. opens the game full-screen (kiosk) with camera + sound pre-allowed
//  5. shuts the server down when the game window is closed
//
// If a folder named "game" sits next to the .exe, those files are used instead of
// the embedded copy (handy for tweaking without rebuilding).
package main

import (
	"bufio"
	"embed"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:game
var embedded embed.FS

const appName = "Catch the Target"

var logger *log.Logger

func main() {
	windowed := flag.Bool("windowed", false, "open in a normal window instead of full-screen kiosk")
	port := flag.Int("port", 8080, "local port (falls back to a free one if busy)")
	options := flag.String("options", "", "extra game options, e.g. \"round=45&model=lite\"")
	serverOnly := flag.Bool("server-only", false, "only run the web server (open the URL yourself)")
	flag.Parse()

	exeDir := exeDirectory()
	dataDir := appDataDir()
	setupLogging(dataDir)

	say("────────────────────────────────────────")
	say("  %s", appName)
	say("────────────────────────────────────────")

	// ── settings.txt next to the exe (optional) ──
	settings := readSettings(filepath.Join(exeDir, "settings.txt"))
	if v, ok := settings["windowed"]; ok && (v == "1" || v == "true" || v == "yes") {
		*windowed = true
	}
	delete(settings, "windowed")
	query := url.Values{}
	for k, v := range settings {
		query.Set(k, v)
	}
	if *options != "" {
		if extra, err := url.ParseQuery(*options); err == nil {
			for k := range extra {
				query.Set(k, extra.Get(k))
			}
		}
	}
	if !*windowed {
		query.Set("kiosk", "1")
	}

	// ── game files: folder next to exe, else embedded ──
	var root http.FileSystem
	if fi, err := os.Stat(filepath.Join(exeDir, "game", "index.html")); err == nil && !fi.IsDir() {
		root = http.Dir(filepath.Join(exeDir, "game"))
		say("✓ Using game files from %s", filepath.Join(exeDir, "game"))
	} else {
		sub, _ := fs.Sub(embedded, "game")
		root = http.FS(sub)
		say("✓ Game files loaded (built in)")
	}

	// ── web server ──
	for ext, typ := range map[string]string{
		".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
		".wasm": "application/wasm", ".task": "application/octet-stream",
		".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fail("Could not start the local web server: %v", err)
		}
	}
	addr := ln.Addr().(*net.TCPAddr)
	mux := http.NewServeMux()
	mux.HandleFunc("/__ping", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "catch-the-target") })
	mux.Handle("/", noCache(http.FileServer(root)))
	go func() { _ = http.Serve(ln, mux) }()
	gameURL := fmt.Sprintf("http://127.0.0.1:%d/?%s", addr.Port, query.Encode())
	say("✓ Game server running at http://127.0.0.1:%d", addr.Port)

	if *serverOnly {
		say("Open %s in Chrome or Edge. Press Ctrl+C to stop.", gameURL)
		select {}
	}

	// ── webcam check (warning only — the game falls back to keyboard mode) ──
	if ok, known := cameraPresent(); known && !ok {
		say("! No webcam detected. Plug one in for body tracking —")
		say("  without it the game starts in keyboard mode.")
	} else if known {
		say("✓ Webcam found")
	}

	// ── browser: find, or install ──
	browser := findBrowser()
	if browser == "" {
		say("… Chrome/Edge not found — installing Google Chrome (this can take a minute)")
		if err := installBrowser(); err != nil {
			say("! Automatic install failed: %v", err)
		}
		browser = findBrowser()
	}
	if browser == "" {
		say("! No compatible browser could be installed. Opening your default browser instead.")
		say("  For best results install Google Chrome: https://www.google.com/chrome/")
		openDefault(gameURL)
		waitForEnter()
		return
	}
	say("✓ Browser: %s", browser)

	profile := filepath.Join(dataDir, "browser-profile")
	_ = os.MkdirAll(profile, 0o755)
	args := []string{
		"--user-data-dir=" + profile,
		"--no-first-run", "--no-default-browser-check",
		"--autoplay-policy=no-user-gesture-required",
		"--use-fake-ui-for-media-stream", // auto-allow the webcam prompt
		"--disable-features=Translate,TranslateUI",
		"--disable-pinch", "--overscroll-history-navigation=0",
		"--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
		"--ignore-gpu-blocklist", "--enable-gpu-rasterization",
	}
	if *windowed {
		args = append(args, "--start-maximized", "--app="+gameURL)
	} else {
		args = append(args, "--kiosk", "--start-fullscreen", gameURL)
	}
	say("▶ Starting the game… (close it with Alt+F4)")
	cmd := exec.Command(browser, args...)
	started := time.Now()
	if err := cmd.Start(); err != nil {
		fail("Could not open the browser: %v", err)
	}
	minimizeConsole()
	_ = cmd.Wait()
	if time.Since(started) < 5*time.Second {
		// the browser handed the window to an already-running instance; keep serving
		restoreConsole()
		say("The game is open in an existing browser window.")
		waitForEnter()
	}
	say("Game closed. Bye!")
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func readSettings(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if i := strings.Index(line, "#"); i > 0 {
			line = strings.TrimSpace(line[:i])
		}
		k, v, ok := strings.Cut(line, "=")
		if ok && strings.TrimSpace(v) != "" {
			out[strings.TrimSpace(strings.ToLower(k))] = strings.TrimSpace(v)
		}
	}
	if len(out) > 0 {
		say("✓ settings.txt: %v", out)
	}
	return out
}

func exeDirectory() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Dir(p)
}

func appDataDir() string {
	base, err := os.UserCacheDir() // %LOCALAPPDATA% on Windows
	if err != nil {
		base = os.TempDir()
	}
	d := filepath.Join(base, "CatchTheTarget")
	_ = os.MkdirAll(d, 0o755)
	return d
}

func setupLogging(dir string) {
	f, err := os.OpenFile(filepath.Join(dir, "launcher.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		logger = log.New(io.Discard, "", 0)
		return
	}
	logger = log.New(f, "", log.LstdFlags)
}

func say(format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	fmt.Println(msg)
	logger.Println(msg)
}

func fail(format string, a ...any) {
	restoreConsole()
	say("✗ "+format, a...)
	waitForEnter()
	os.Exit(1)
}

func waitForEnter() {
	fmt.Println("\nPress Enter to close this window.")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func download(urlStr, dest string) error {
	client := &http.Client{Timeout: 10 * time.Minute}
	resp, err := client.Get(urlStr)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
}
