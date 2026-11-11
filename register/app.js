// Tablet registration: Welcome → (Single | Two players) → Player 1 [→ Player 2] → Thank you.
// Talks to the game PC through the same server that served this page (/api/...).

const $ = (id) => document.getElementById(id);
const screens = ['welcome', 'mode', 'form', 'thanks'];
const IDLE_RESET_MS = 90_000;     // abandoned form → back to Welcome (clears what was typed)
const THANKS_RESET_MS = 15_000;   // Thank-you screen returns to Welcome for the next people

let state = null;          // last /api/state
let online = null;         // server reachable?
let reg = null;            // { mode, step, players: [{name, email}] }
let lastReg = null;        // { id, names } of the group just registered
let idleTimer = null, thanksTimer = null;

// ── helpers ──
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const txt = (en) => el('span', '', en);
async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, data };
}

function show(name) {
  for (const s of screens) $('s-' + s).classList.toggle('hidden', s !== name);
  clearTimeout(idleTimer); clearTimeout(thanksTimer);
  if (name === 'mode' || name === 'form') armIdle();
  if (name === 'thanks') thanksTimer = setTimeout(reset, THANKS_RESET_MS);
}
function armIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(reset, IDLE_RESET_MS); }
function reset() { reg = null; clearForm(); show('welcome'); }
['pointerdown', 'keydown', 'input'].forEach((ev) => addEventListener(ev, () => { if (!$('s-mode').classList.contains('hidden') || !$('s-form').classList.contains('hidden')) armIdle(); }, { passive: true }));

// ── welcome / mode ──
$('startBtn').onclick = () => { reg = null; show('mode'); };
document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => show(b.dataset.back)));
document.querySelectorAll('.mode').forEach((b) => (b.onclick = () => {
  const mode = b.dataset.mode;
  reg = { mode, step: 0, players: mode === 'multi' ? [{ name: '', email: '' }, { name: '', email: '' }] : [{ name: '', email: '' }] };
  openStep();
}));

// ── form ──
const nameIn = $('name'), emailIn = $('email');
function syncFilled() { for (const i of [nameIn, emailIn]) i.closest('.input').classList.toggle('filled', i.value.length > 0); }
[nameIn, emailIn].forEach((i) => i.addEventListener('input', () => { syncFilled(); i.closest('.field').classList.remove('invalid'); $(i.id + 'Err').textContent = ''; $('formMsg').textContent = ''; }));
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); emailIn.focus(); } });
emailIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); emailIn.blur(); next(); } });

function clearForm() {
  nameIn.value = ''; emailIn.value = '';
  for (const id of ['nameErr', 'emailErr', 'formMsg']) $(id).textContent = '';
  document.querySelectorAll('.field').forEach((f) => f.classList.remove('invalid'));
  syncFilled();
}

function openStep() {
  const { mode, step, players } = reg;
  clearForm();
  nameIn.value = players[step].name; emailIn.value = players[step].email; syncFilled();
  const chip = $('stepChip'); chip.replaceChildren(); chip.className = 'step' + (step === 1 ? ' p2' : '');
  if (mode === 'multi') {
    chip.append(el('span', 'pdot'), txt(`Player ${step + 1} of 2`));
  } else {
    chip.append(el('span', 'pdot'), txt('Single player'));
  }
  const last = step === players.length - 1;
  $('nextEn').textContent = last ? 'Submit' : 'Next';
  show('form');
}

function fieldError(id, en) {
  const e = $(id + 'Err'); e.replaceChildren(txt(en));
  $(id).closest('.field').classList.add('invalid');
}

function collect() {
  const name = nameIn.value.replace(/\s+/g, ' ').trim();
  const email = emailIn.value.trim();
  let ok = true;
  if (!name) { fieldError('name', 'Please enter a name'); ok = false; }
  if (email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) { fieldError('email', 'Please check the email address'); ok = false; }
  if (ok) Object.assign(reg.players[reg.step], { name, email });
  return ok;
}

$('formBack').onclick = () => {
  if (!reg || reg.step === 0) return show('mode');
  collect(); reg.step--; openStep();
};
$('formNext').onclick = next;

async function next() {
  if (!reg || !collect()) return;
  if (reg.step < reg.players.length - 1) { reg.step++; openStep(); nameIn.focus(); return; }
  const btn = $('formNext'); btn.disabled = true;
  $('formMsg').textContent = '';
  try {
    const r = await api('register', { mode: reg.mode, players: reg.players });
    if (r.ok) {
      lastReg = { id: r.data.id, names: reg.players.map((p) => p.name) };
      renderThanks();
      reg = null;
      show('thanks');
      refresh();
    } else {
      const err = r.data?.error;
      if (err === 'name_required' || err === 'bad_email') {
        reg.step = (r.data.player || 1) - 1; openStep();
        err === 'name_required' ? fieldError('name', 'Please enter a name') : fieldError('email', 'Please check the email address');
      } else if (err === 'queue_full') formMsg('The queue is full — please wait a moment.');
      else formMsg('Something went wrong. Please try again.');
    }
  } catch {
    formMsg("Can't reach the game computer. Check the Wi-Fi and try again.");
  } finally { btn.disabled = false; }
}
function formMsg(en) { $('formMsg').replaceChildren(txt(en)); }

// ── thank you ──
function renderThanks() {
  const who = $('thanksNames'); who.replaceChildren();
  lastReg.names.forEach((n, i) => { const s = el('span', i === 1 ? 'p2' : ''); s.append(el('bdi', '', n)); who.append(s); });
  renderTurn();
}
function renderTurn() {
  const t = $('turnInfo'); if (!lastReg || !state) { t.replaceChildren(); return; }
  t.className = 'turn';
  if (state.current?.id === lastReg.id) {
    t.classList.add('go');
    t.replaceChildren(txt("It's your turn! Go to the screen and raise one hand."));
    return;
  }
  const i = state.queue.findIndex((s) => s.id === lastReg.id);
  if (i < 0) { t.replaceChildren(); return; }
  const ahead = i + (state.current ? 1 : 0);
  if (ahead === 0) t.replaceChildren(txt("You're next! Go to the screen."));
  else t.replaceChildren(txt(`${ahead} ${ahead === 1 ? 'group' : 'groups'} ahead of you`));
}
$('doneBtn').onclick = reset;

// ── status chip + queue sheet ──
function renderChip() {
  const dot = $('linkDot'), txt = $('linkText');
  dot.className = 'dot';
  if (online === false) { dot.classList.add('off'); txt.textContent = 'Not connected to the game computer'; return; }
  if (!state) { txt.textContent = 'Connecting…'; return; }
  const waiting = state.queue.length;
  if (!state.gameOnline) { dot.classList.add('off'); txt.textContent = `Game screen not open · ${waiting} waiting`; return; }
  dot.classList.add('on');
  const now = state.current ? (state.current.status === 'waiting' ? 'Players getting ready' : 'Game in progress') : 'Ready for players';
  txt.textContent = `${now} · ${waiting} waiting`;
}

const STATUS = { waiting: 'Getting ready', countdown: 'Starting', playing: 'Playing', results: 'Results', done: 'Finished', noshow: "Didn't show up", cancelled: 'Removed' };
function namesNode(s, withScores) {
  const n = el('div', 'names');
  s.players.forEach((p, i) => {
    const span = el('span'); const b = el('bdi', '', p.name); span.append(b);
    if (withScores && s.results?.[i]) span.append(' ', el('span', 'score', String(s.results[i].score)));
    if (withScores && s.winner === i && s.mode === 'multi') span.append(' 🏆');
    n.append(span);
  });
  return n;
}
function renderSheet() {
  const body = $('sheetBody'); body.replaceChildren();
  if (!state) { body.append(el('div', 'q-empty', online === false ? 'Not connected to the game computer.' : 'Loading…')); return; }
  const row = (s, meta, removable, withScores) => {
    const r = el('div', 'q-row'); r.append(namesNode(s, withScores), el('span', 'meta', meta));
    if (removable) { const b = el('button', '', 'Remove'); b.onclick = async () => { b.disabled = true; await api('remove', { id: s.id }).catch(() => {}); refresh(); }; r.append(b); }
    return r;
  };
  body.append(el('div', 'q-sec', 'NOW AT THE SCREEN'));
  if (state.current) body.append(row(state.current, `${state.current.mode === 'multi' ? '2 players' : '1 player'} · ${STATUS[state.current.status] || state.current.status}`, state.current.status === 'waiting', false));
  else body.append(el('div', 'q-empty', 'Nobody — the next group will be called in automatically.'));
  body.append(el('div', 'q-sec', `WAITING (${state.queue.length})`));
  if (!state.queue.length) body.append(el('div', 'q-empty', 'No one waiting.'));
  state.queue.forEach((s, i) => body.append(row(s, `#${i + 1} · ${s.mode === 'multi' ? '2 players' : '1 player'}`, true, false)));
  const done = state.recent.filter((s) => s.status === 'done');
  if (done.length) {
    body.append(el('div', 'q-sec', 'RECENT RESULTS'));
    done.slice(0, 5).forEach((s) => body.append(row(s, new Date(s.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), false, true)));
  }
}
$('queueBtn').onclick = () => { renderSheet(); $('sheet').classList.remove('hidden'); };
$('sheetClose').onclick = () => $('sheet').classList.add('hidden');
$('sheet').onclick = (e) => { if (e.target.id === 'sheet') $('sheet').classList.add('hidden'); };

// ── polling ──
async function refresh() {
  try {
    const r = await api('state');
    if (!r.ok) throw new Error();
    state = r.data; online = true;
  } catch { online = false; }
  renderChip();
  if (!$('s-thanks').classList.contains('hidden')) renderTurn();
  if (!$('sheet').classList.contains('hidden')) renderSheet();
}
setInterval(refresh, 1000);
refresh();
show('welcome');
