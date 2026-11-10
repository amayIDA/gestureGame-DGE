// Game ↔ tablet link: a small in-memory player queue shared over the local network.
//
//	Tablet (registration app)  ──POST /api/register──▶  queue
//	Game screen                ──POST /api/next──────▶  takes the next registered group
//	Game screen                ──POST /api/status────▶  waiting / countdown / playing / results / done
//	Both                       ──GET  /api/state─────▶  polled twice a second
//
// Every registration and result is also appended to registrations.csv (UTF-8 with BOM,
// so Excel shows Arabic names correctly).
//
// server.py (Mac) implements exactly the same API — keep the two in sync.
package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

type Player struct {
	Name  string `json:"name"`
	Email string `json:"email,omitempty"`
}

type Result struct {
	Name    string `json:"name"`
	Score   int    `json:"score"`
	Correct int    `json:"correct"`
	Wrong   int    `json:"wrong"`
	Best    int    `json:"best"`
}

type Session struct {
	ID      string
	Mode    string // "single" | "multi"
	Players []Player
	Status  string // queued, waiting, countdown, playing, results, done, noshow, cancelled
	Results []Result
	Winner  *int // index into Players, nil = tie / solo
	Created int64
	Updated int64
}

// what clients see (emails are never sent back out)
func (s *Session) view() map[string]any {
	names := make([]map[string]string, len(s.Players))
	for i, p := range s.Players {
		names[i] = map[string]string{"name": p.Name}
	}
	return map[string]any{
		"id": s.ID, "mode": s.Mode, "players": names, "status": s.Status,
		"results": s.Results, "winner": s.Winner, "created": s.Created, "updated": s.Updated,
	}
}

type Hub struct {
	mu       sync.Mutex
	seq      int
	nextID   int
	queue    []*Session
	current  *Session
	recent   []*Session
	lastGame time.Time
	csvPath  string
	port     int
}

func NewHub(csvPath string, port int) *Hub { return &Hub{csvPath: csvPath, port: port, nextID: 1} }

func nowMs() int64 { return time.Now().UnixMilli() }

func (h *Hub) finish(s *Session, status string) {
	s.Status, s.Updated = status, nowMs()
	h.recent = append([]*Session{s}, h.recent...)
	if len(h.recent) > 10 {
		h.recent = h.recent[:10]
	}
}

func (h *Hub) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/api/info", h.handleInfo)
	mux.HandleFunc("/api/state", h.handleState)
	mux.HandleFunc("/api/register", h.handleRegister)
	mux.HandleFunc("/api/next", h.handleNext)
	mux.HandleFunc("/api/status", h.handleStatus)
	mux.HandleFunc("/api/remove", h.handleRemove)
}

func (h *Hub) handleInfo(w http.ResponseWriter, r *http.Request) {
	urls := []string{}
	for _, ip := range lanIPs() {
		urls = append(urls, fmt.Sprintf("http://%s:%d/register/", ip, h.port))
	}
	writeJSON(w, 200, map[string]any{"port": h.port, "tabletUrls": urls})
}

func (h *Hub) handleState(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.URL.Query().Get("client") == "game" {
		h.lastGame = time.Now()
	}
	q := make([]any, len(h.queue))
	for i, s := range h.queue {
		q[i] = s.view()
	}
	rec := make([]any, len(h.recent))
	for i, s := range h.recent {
		rec[i] = s.view()
	}
	var cur any
	if h.current != nil {
		cur = h.current.view()
	}
	writeJSON(w, 200, map[string]any{
		"seq": h.seq, "now": nowMs(), "gameOnline": time.Since(h.lastGame) < 4*time.Second,
		"current": cur, "queue": q, "recent": rec,
	})
}

func (h *Hub) handleRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode    string   `json:"mode"`
		Players []Player `json:"players"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	want := map[string]int{"single": 1, "multi": 2}[body.Mode]
	if want == 0 || len(body.Players) != want {
		writeJSON(w, 400, map[string]any{"error": "bad_mode"})
		return
	}
	players := make([]Player, want)
	for i, p := range body.Players {
		name := cleanText(p.Name, 30)
		email := cleanText(p.Email, 100)
		if name == "" {
			writeJSON(w, 400, map[string]any{"error": "name_required", "player": i + 1})
			return
		}
		if email != "" && (!strings.Contains(email, "@") || strings.ContainsAny(email, " ,;")) {
			writeJSON(w, 400, map[string]any{"error": "bad_email", "player": i + 1})
			return
		}
		players[i] = Player{Name: name, Email: email}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.queue) >= 30 {
		writeJSON(w, 409, map[string]any{"error": "queue_full"})
		return
	}
	s := &Session{ID: fmt.Sprintf("S%03d", h.nextID), Mode: body.Mode, Players: players, Status: "queued", Created: nowMs(), Updated: nowMs()}
	h.nextID++
	h.queue = append(h.queue, s)
	h.seq++
	ahead := len(h.queue) - 1
	if h.current != nil {
		ahead++
	}
	for i, p := range players {
		h.logCSV("registered", s, i, p, nil)
	}
	writeJSON(w, 200, map[string]any{"id": s.ID, "ahead": ahead})
}

// The game asks for the next group when it's idle. Returns the group in progress if any.
func (h *Hub) handleNext(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method"})
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastGame = time.Now()
	if h.current == nil && len(h.queue) > 0 {
		h.current, h.queue = h.queue[0], h.queue[1:]
		h.current.Status, h.current.Updated = "waiting", nowMs()
		h.seq++
	}
	var cur any
	if h.current != nil {
		cur = h.current.view()
	}
	writeJSON(w, 200, map[string]any{"session": cur})
}

func (h *Hub) handleStatus(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID      string   `json:"id"`
		Status  string   `json:"status"`
		Results []Result `json:"results"`
		Winner  *int     `json:"winner"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	valid := map[string]bool{"waiting": true, "countdown": true, "playing": true, "results": true, "done": true, "noshow": true}
	if !valid[body.Status] {
		writeJSON(w, 400, map[string]any{"error": "bad_status"})
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastGame = time.Now()
	s := h.current
	if s == nil || s.ID != body.ID {
		writeJSON(w, 409, map[string]any{"error": "not_current"})
		return
	}
	if body.Status == "results" {
		for i := range body.Results {
			body.Results[i].Name = cleanText(body.Results[i].Name, 30)
		}
		s.Results, s.Winner = body.Results, body.Winner
		for i, p := range s.Players {
			var res *Result
			if i < len(s.Results) {
				res = &s.Results[i]
			}
			h.logCSV("result", s, i, p, res)
		}
	}
	if body.Status == "done" || body.Status == "noshow" {
		if body.Status == "noshow" {
			for i, p := range s.Players {
				h.logCSV("noshow", s, i, p, nil)
			}
		}
		h.finish(s, body.Status)
		h.current = nil
	} else {
		s.Status, s.Updated = body.Status, nowMs()
	}
	h.seq++
	writeJSON(w, 200, map[string]any{"ok": true})
}

// Tablet: remove a queued group (or one that hasn't started playing yet).
func (h *Hub) handleRemove(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID string `json:"id"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, s := range h.queue {
		if s.ID == body.ID {
			h.queue = append(h.queue[:i], h.queue[i+1:]...)
			h.finish(s, "cancelled")
			for j, p := range s.Players {
				h.logCSV("cancelled", s, j, p, nil)
			}
			h.seq++
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
	}
	if h.current != nil && h.current.ID == body.ID && h.current.Status == "waiting" {
		s := h.current
		h.current = nil
		h.finish(s, "cancelled")
		for j, p := range s.Players {
			h.logCSV("cancelled", s, j, p, nil)
		}
		h.seq++
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	writeJSON(w, 409, map[string]any{"error": "not_removable"})
}

// ── CSV log ──
func (h *Hub) logCSV(event string, s *Session, idx int, p Player, res *Result) {
	if h.csvPath == "" {
		return
	}
	_, statErr := os.Stat(h.csvPath)
	f, err := os.OpenFile(h.csvPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	cw := csv.NewWriter(f)
	cw.UseCRLF = true // Excel-friendly line endings
	if os.IsNotExist(statErr) {
		f.WriteString("\xEF\xBB\xBF") // BOM so Excel reads UTF-8 (Arabic) correctly
		cw.Write([]string{"time", "event", "session", "mode", "player", "name", "email", "score", "correct", "wrong", "outcome"})
	}
	score, correct, wrong, outcome := "", "", "", ""
	if res != nil {
		score, correct, wrong = fmt.Sprint(res.Score), fmt.Sprint(res.Correct), fmt.Sprint(res.Wrong)
		switch {
		case s.Mode == "single":
			outcome = "solo"
		case s.Winner == nil:
			outcome = "tie"
		case *s.Winner == idx:
			outcome = "win"
		default:
			outcome = "lose"
		}
	}
	cw.Write([]string{time.Now().Format("2006-01-02 15:04:05"), event, s.ID, s.Mode, fmt.Sprint(idx + 1),
		safeCell(p.Name), safeCell(p.Email), score, correct, wrong, outcome})
	cw.Flush()
}

// stop spreadsheet formula injection (=, +, -, @ at the start of a cell)
func safeCell(v string) string {
	if v != "" && strings.ContainsRune("=+-@\t\r", rune(v[0])) {
		return "'" + v
	}
	return v
}

// trims, drops control characters, collapses whitespace, limits length (in characters)
func cleanText(v string, max int) string {
	var b strings.Builder
	space := false
	for _, r := range strings.TrimSpace(v) {
		if unicode.IsSpace(r) {
			if !space {
				b.WriteRune(' ')
			}
			space = true
			continue
		}
		if unicode.IsControl(r) {
			continue
		}
		space = false
		b.WriteRune(r)
	}
	out := []rune(strings.TrimSpace(b.String()))
	if len(out) > max {
		out = out[:max]
	}
	return strings.TrimSpace(string(out))
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "method"})
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad_json"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// Private IPv4 addresses of this computer (what the tablet should use), best first.
func lanIPs() []string {
	var out []string
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(ifc.Name)
		if strings.Contains(name, "vmware") || strings.Contains(name, "virtualbox") || strings.Contains(name, "vethernet") || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "utun") {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || !ip.IsPrivate() {
				continue
			}
			out = append(out, ip.String())
		}
	}
	rank := func(s string) int {
		switch {
		case strings.HasPrefix(s, "192.168."):
			return 0
		case strings.HasPrefix(s, "10."):
			return 1
		default:
			return 2
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return rank(out[i]) < rank(out[j]) })
	return out
}

func csvLocation(exeDir, dataDir string) string {
	p := filepath.Join(exeDir, "registrations.csv")
	if f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		f.Close()
		if st, _ := os.Stat(p); st != nil && st.Size() == 0 {
			os.Remove(p) // created just to test; real header is written on first use
		}
		return p
	}
	return filepath.Join(dataDir, "registrations.csv")
}
