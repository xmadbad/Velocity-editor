// Lizzie arayüzü: TfL'yi yoklar, hapı ve paneli çizer, hatırlatır, değişince haber verir.
import {
  DEFAULTS, LEVEL_TEXT, MIN, Tracker, atTime, atToday, buildRoutes, dayMode, fmtDuration,
  fmtTime, insight, nameIndex, parseStatus, plan, stationsFromStopPoints, trainsForTrip,
} from './logic.js';
import { FACE_SVG, MINI_TRAIN } from './face.js';

const API = 'https://api.tfl.gov.uk';
const DAY = 24 * 60 * MIN;
const SPAN = 30; // zaman çizelgesi kaç dakikalık
const STATE_TEXT = { relaxed: 'rahat', now: 'şimdi', run: 'koş!' };

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
async function call(cmd, args) {
  if (!invoke) return null;
  try {
    return await invoke(cmd, args);
  } catch (e) {
    console.warn(cmd, e);
    return null;
  }
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`lizzie:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`lizzie:${key}`, JSON.stringify(value));
    } catch {}
  },
};

let settings = { ...DEFAULTS, ...store.get('settings', {}) };
let tracker = new Tracker();
const configured = () => Boolean(settings.fromId && settings.toId);

const state = {
  stations: store.get('stations', null)?.list || [],
  routes: store.get('routes', null)?.list || [],
  trip: null, // trainsForTrip sonucu
  status: null, // parseStatus sonucu
  fetchedAt: 0,
  statusAt: 0,
  error: '',
  view: 'pill', // 'pill' | 'main' | 'settings'
  growUp: null,
  alerts: [], // { title, body, at }
  alertUntil: 0,
};

// ------------------------------------------------------------------ TfL

async function tfl(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = API + path + (settings.appKey ? `${sep}app_key=${encodeURIComponent(settings.appKey)}` : '');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw Object.assign(new Error(`TfL HTTP ${res.status}`), { http: res.status });
    return await res.json();
  } catch (e) {
    if (e.http || !invoke) throw e;
    return JSON.parse(await invoke('tfl_get', { url })); // webview'den olmadıysa Rust'tan dene
  }
}

async function ensureStations(force = false) {
  const cached = store.get('stations', null);
  if (!force && cached?.list?.length && Date.now() - cached.at < 7 * DAY) {
    state.stations = cached.list;
    return;
  }
  const list = stationsFromStopPoints(await tfl('/Line/elizabeth/StopPoints'));
  if (list.length) {
    state.stations = list;
    store.set('stations', { at: Date.now(), list });
  }
}

async function ensureRoutes() {
  const cached = store.get('routes', null);
  if (cached?.list?.length && Date.now() - cached.at < DAY) {
    state.routes = cached.list;
    return;
  }
  const seqs = await Promise.all(
    ['outbound', 'inbound'].map((d) => tfl(`/Line/elizabeth/Route/Sequence/${d}`).catch(() => null)),
  );
  const list = buildRoutes(seqs.filter(Boolean));
  if (list.length) {
    state.routes = list;
    store.set('routes', { at: Date.now(), list });
  }
}

let loadingArrivals = false;
async function refreshArrivals() {
  if (!configured() || loadingArrivals) return;
  loadingArrivals = true;
  try {
    await Promise.all([ensureRoutes().catch(() => {}), state.stations.length ? null : ensureStations().catch(() => {})]);
    const preds = await tfl(`/Line/elizabeth/Arrivals/${encodeURIComponent(settings.fromId)}`);
    state.trip = trainsForTrip(preds, {
      fromId: settings.fromId,
      toId: settings.toId,
      routes: state.routes,
      nameToId: nameIndex(state.stations),
    });
    state.fetchedAt = Date.now();
    state.error = '';
    watchForChanges();
  } catch (e) {
    state.error = friendlyError(e);
  } finally {
    loadingArrivals = false;
    render();
  }
}

async function refreshStatus() {
  try {
    state.status = parseStatus(await tfl('/Line/elizabeth/Status'));
    state.statusAt = Date.now();
    watchStatus();
  } catch (e) {
    console.warn('status', e);
  }
  render();
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/429/.test(msg)) return 'TfL biraz yoruldu, birazdan tekrar denerim';
  if (/HTTP/.test(msg)) return msg;
  return 'İnternete ulaşamadım';
}

// ------------------------------------------------------------------ plan ve haberler

function currentPlan(now = Date.now()) {
  const trip = state.trip;
  if (!trip) return null;
  const uncertain = !trip.trains.length && trip.unknown.length > 0;
  return { ...plan(uncertain ? trip.unknown : trip.trains, now, settings), uncertain };
}

const isLive = (now = Date.now()) => configured() && dayMode(now, settings) === 'live';
const today = (now = Date.now()) => new Date(now).toDateString();

function once(key) {
  const seen = store.get('once', {});
  if (seen[key]) return false;
  const day = today();
  for (const k of Object.keys(seen)) if (!k.endsWith(day)) delete seen[k];
  seen[key] = true;
  store.set('once', seen);
  return true;
}

function say(title, body) {
  state.alerts = [{ title, body, at: Date.now() }, ...state.alerts].slice(0, 3);
  state.alertUntil = Date.now() + 25_000;
  if (settings.notify) call('notify', { title, body });
  render();
}

function planLine(p) {
  const t = p?.target;
  return t ? `Yeni plan: ${atTime(t.leaveBy)} çık, ${fmtTime(t.time)} trenine bin.` : 'Şimdilik başka tren görünmüyor.';
}

function watchForChanges() {
  const now = Date.now();
  if (!isLive(now)) return;
  const p = currentPlan(now);
  for (const ev of tracker.update(p, now)) {
    if (ev.type === 'shift' && ev.delta > 0) {
      say(`😿 Trenin ${ev.delta} dk gecikti`, `${fmtTime(ev.from.base)} treni artık ${fmtTime(ev.to.time)} görünüyor. ${planLine(p)}`);
    } else if (ev.type === 'shift') {
      say(`⏩ Trenin ${-ev.delta} dk erkene kaydı`, `${fmtTime(ev.from.base)} treni artık ${fmtTime(ev.to.time)}. ${planLine(p)}`);
    } else if (ev.type === 'gone') {
      say(`⚠️ ${fmtTime(ev.from.time)} treni listeden düştü`, `İptal olmuş olabilir. ${planLine(p)}`);
    }
  }
}

function watchReminders(p, now) {
  const t = p?.target;
  if (!t || !isLive(now) || now < p.L - 45 * MIN) return;
  const day = today(now);
  const remindMin = Number(settings.remindMin) || 0;
  if (remindMin > 1 && t.slack <= remindMin && t.slack > 1.5 && once(`remind:${day}`)) {
    say('🎒 Toparlanma vakti', `${fmtTime(t.time)} trenine yetişmek için ${atTime(t.leaveBy)} çık (${fmtDuration(Math.ceil(t.slack))} kaldı).`);
  }
  if (t.slack <= 1 && t.slack >= -0.5 && once(`go:${day}`)) {
    const next = p.alt ? ` Kaçırırsan sonraki ${fmtTime(p.alt.time)}.` : '';
    say('🏃 Çıkış vakti!', `${fmtTime(t.time)} treni (${t.dest}) için şimdi çık.${next}`);
  }
}

function watchStatus() {
  const s = state.status;
  if (!s || s.level === 'unknown' || !isLive()) return;
  const key = `status:${today()}`;
  const prev = store.get(key, null);
  if (prev === s.level) return;
  store.set(key, s.level);
  if (prev === null && s.level === 'good') return;
  if (s.level === 'good') say('✨ Elizabeth line düzeldi', 'Hat yeniden iyi serviste. Plan normale döndü.');
  else say(`${s.level === 'minor' ? '😿' : '🚨'} Elizabeth line: ${LEVEL_TEXT[s.level]}`, s.reason || s.desc);
}

// ------------------------------------------------------------------ çizim

function moodFor(kind) {
  const level = state.status?.level;
  if (level === 'bad' || level === 'closed') return 'sad';
  if (level === 'minor' && kind !== 'alert') return 'worried';
  return kind;
}

// Hapın ne diyeceği: { headline, sub, badge, badgeClass, kind, plan }
function pillModel(now) {
  if (!configured()) {
    return { headline: 'Merhaba, ben Lizzie 💜', sub: 'Tıkla, iş ve ev durağını seçelim', kind: 'happy' };
  }
  const mode = dayMode(now, settings);
  const L = atToday(now, settings.leaveAt);
  const statusLine = `Elizabeth line · ${LEVEL_TEXT[state.status?.level || 'unknown']}`;
  const watching = mode === 'live' || state.view !== 'pill';

  if (!watching) {
    if (mode === 'before') {
      return { headline: `Eve dönüş ${fmtTime(L)}`, sub: statusLine, badge: shortDuration((L - now) / MIN), badgeClass: 's-idle', kind: 'calm' };
    }
    const weekend = [0, 6].includes(new Date(now).getDay());
    const headline = mode === 'after' ? 'Bugünlük bu kadar 🌙' : weekend ? 'İyi hafta sonları 🌸' : 'Bugün izinlisin 🌸';
    return { headline, sub: statusLine, kind: 'sleepy' };
  }

  const p = currentPlan(now);
  if (!p) {
    return state.error
      ? { headline: 'Bağlantı yok 📡', sub: state.error, kind: 'sleepy' }
      : { headline: 'Lizzie bakıyor…', sub: `${settings.fromName} → ${settings.toName}`, kind: 'calm' };
  }

  const t = p.target;
  if (!t) {
    if (p.early && p.list.length) {
      return { headline: `Eve dönüş ${fmtTime(L)}`, sub: 'Tahminler yaklaşınca netleşecek', badge: shortDuration((L - now) / MIN), badgeClass: 's-idle', kind: 'calm', plan: p };
    }
    return { headline: 'Tren görünmüyor 🤔', sub: state.error || statusLine, kind: 'worried', plan: p };
  }

  const stale = state.error && now - state.fetchedAt > 3 * MIN ? `📡 ${state.error} · ${ago(now - state.fetchedAt)}` : '';
  const where = stale || `${fmtTime(t.time)} treni → ${t.dest}${t.platform ? ` · Peron ${t.platform}` : ''}`;
  if (t.state === 'run') {
    const sub = p.alt ? `Yetişemezsen: ${fmtTime(p.alt.time)} (${atTime(p.alt.leaveBy)} çık)` : where;
    return { headline: 'Koş, yetişirsin! 🏃', sub, badge: 'hemen', badgeClass: 's-run', kind: 'alert', shake: true, plan: p };
  }
  if (t.state === 'now') {
    return { headline: 'Şimdi çık 🎒', sub: where, badge: `${Math.ceil(t.slack)} dk`, badgeClass: 's-now', kind: 'alert', plan: p };
  }
  return { headline: `${atTime(t.leaveBy)} çık`, sub: where, badge: fmtDuration(Math.ceil(t.slack)), badgeClass: 's-relaxed', kind: 'happy', plan: p };
}

// Hapın rozetine sığsın: 3 saatten uzunsa yalnızca saat.
function shortDuration(min) {
  return min >= 180 ? `${Math.round(min / 60)} sa` : fmtDuration(Math.ceil(min));
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// Her saniye çiziyoruz; değişmeyen HTML'i yeniden basmayalım ki tıklamalar kaybolmasın.
function setHTML(el, html) {
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

let lastTooltip = '';
let lastMoodClass = '';
function renderPill(now) {
  const m = pillModel(now);
  const alerting = now < state.alertUntil && state.alerts.length;
  const a = alerting ? state.alerts[0] : null;

  setText($('headline'), a ? a.title : m.headline);
  setText($('sub'), a ? a.body : m.sub || '');
  $('pill').title = a ? `${a.title}\n${a.body}` : `${m.headline}\n${m.sub || ''}`;
  $('pill').classList.toggle('alerting', Boolean(a));

  const badge = $('badge');
  badge.hidden = Boolean(a) || !m.badge;
  if (m.badge) {
    setText(badge, m.badge);
    badge.className = `badge ${m.badgeClass || ''}`;
  }

  const moodClass = `face m-${a ? 'alert' : moodFor(m.kind)}${m.shake ? ' shake' : ''}`;
  if (moodClass !== lastMoodClass) {
    $('face').firstElementChild.setAttribute('class', moodClass);
    lastMoodClass = moodClass;
  }
  const level = state.status?.level || 'unknown';
  $('dot').className = `dot ${level}`;
  $('dot').title = `Elizabeth line: ${LEVEL_TEXT[level]}`;

  renderTimeline(a ? null : m.plan, now);

  const tooltip = `${m.headline} · ${m.sub || ''}`.slice(0, 120);
  if (tooltip !== lastTooltip) {
    lastTooltip = tooltip;
    call('set_tooltip', { text: tooltip });
  }
  return m;
}

function renderTimeline(p, now) {
  const tl = $('tl');
  const visible = p?.list.some((t) => t.slack <= SPAN);
  tl.hidden = !visible;
  if (!visible) return;

  const track = $('tl-track');
  const want = new Map();
  for (const t of p.list) if (t.slack <= SPAN) want.set(t.key, t);
  for (const el of [...track.children]) if (!want.has(el.dataset.key)) el.remove();
  for (const [key, t] of want) {
    let el = [...track.children].find((c) => c.dataset.key === key);
    if (!el) {
      el = document.createElement('i');
      el.dataset.key = key;
      track.appendChild(el);
    }
    const isTarget = p.target?.key === key;
    el.className = `${isTarget ? 'tl-train' : 'tl-dot'} s-${t.state}`;
    if (isTarget !== Boolean(el.firstElementChild)) el.innerHTML = isTarget ? MINI_TRAIN : '';
    el.style.left = `${Math.max(0, Math.min(1, t.slack / SPAN)) * 100}%`;
    el.title = `${fmtTime(t.time)} → ${t.dest} · ${atTime(t.leaveBy)} çık`;
  }
}

function renderMain(now, m) {
  setHTML($('alerts'), state.alerts
    .map((a, i) => `<div class="alert"><b>${esc(a.title)}<time>${fmtTime(a.at)}</time></b><span>${esc(a.body)}</span><button data-dismiss="${i}" title="Kapat">×</button></div>`)
    .join(''));

  const s = state.status || { level: 'unknown', desc: '', reason: '' };
  const emoji = { good: '✨', minor: '😿', bad: '🚨', closed: '⛔', unknown: '🤔' }[s.level];
  $('status').className = `status ${s.level}`;
  setText($('status-title'), `Elizabeth line · ${LEVEL_TEXT[s.level]} ${emoji}`);
  const showDesc = s.level !== 'good' && s.desc && !s.reason.toLowerCase().startsWith(s.desc.toLowerCase());
  setText($('status-reason'), [showDesc ? s.desc : '', s.reason].filter(Boolean).join(' — '));

  setText($('route'), configured() ? `${settings.fromName} → ${settings.toName}` : '');

  const p = m.plan || currentPlan(now);
  const tip = p ? insight(p) : '';
  $('insight').hidden = !tip;
  setText($('insight'), tip ? `💡 ${tip}` : '');

  const rows = (p?.list || []).slice(0, 6).map((t) => `
    <li class="s-${t.state}${p.target?.key === t.key ? ' is-target' : ''}">
      <b class="t">${fmtTime(t.time)}</b>
      <span class="d">${esc(t.dest)}</span>
      <span class="chip" title="${STATE_TEXT[t.state]}">${atTime(t.leaveBy)} çık</span>
    </li>`);
  const empty = !configured() ? 'Önce ayarlardan durakları seç ⚙' : state.trip ? 'Şu an yetişebileceğin tren görünmüyor' : state.error || 'Yükleniyor…';
  setHTML($('trains'), rows.length ? rows.join('') : `<li class="empty">${esc(empty)}</li>`);

  $('note').hidden = !p?.uncertain;
  setText($('note'), p?.uncertain ? '⚠ Rota bilgisi eşleşmedi, bu duraktaki tüm trenleri gösteriyorum.' : '');

  const parts = [];
  if (state.fetchedAt) parts.push(`↻ ${ago(now - state.fetchedAt)}`);
  if (state.trip) parts.push(`${state.trip.total} tahmin, ${state.trip.trains.length} uygun`);
  if (state.error) parts.push(state.error);
  setText($('updated'), parts.join(' · '));
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} sn önce` : `${Math.round(s / 60)} dk önce`;
}

let fittedHeight = 0;
function render() {
  const now = Date.now();
  const m = renderPill(now);
  if (state.view === 'main') renderMain(now, m);
  // Panelin içeriği büyüyüp küçüldükçe pencere de ona uysun.
  if (state.view !== 'pill' && Math.ceil($('app').getBoundingClientRect().height) !== fittedHeight) fitWindow();
}

// ------------------------------------------------------------------ pencere ve görünüm

async function fitWindow() {
  if (!invoke) return;
  const height = Math.ceil($('app').getBoundingClientRect().height);
  fittedHeight = height;
  state.growUp = await call('set_height', { height, growUp: state.growUp });
}

async function setView(view) {
  if (view !== 'pill' && state.view === 'pill') {
    // Ekranın alt yarısındaysak panel yukarı açılsın; kapanırken aynı kenara tutun.
    const mid = (screen.availTop || 0) + screen.availHeight / 2;
    state.growUp = window.screenY + window.innerHeight / 2 > mid;
    $('app').classList.toggle('up', state.growUp);
  }
  state.view = view;
  $('panel').hidden = view === 'pill';
  $('view-main').hidden = view !== 'main';
  $('view-settings').hidden = view !== 'settings';
  if (view === 'settings') fillSettings();
  if (view !== 'pill') {
    nextArrivals = 0;
    if (Date.now() - state.statusAt > 2 * MIN) nextStatus = 0;
  }
  render();
  await fitWindow();
  if (view === 'pill') {
    $('app').classList.remove('up');
    state.growUp = null;
  }
}

function toggle() {
  if (!configured()) setView(state.view === 'settings' ? 'pill' : 'settings');
  else setView(state.view === 'pill' ? 'main' : 'pill');
}

// Hap hem tıklanır hem sürüklenir: 4 pikselden fazla kayarsa sürükle, yoksa aç/kapa.
let press = null;
$('pill').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  press = { x: e.screenX, y: e.screenY, dragging: false };
});
$('pill').addEventListener('pointermove', (e) => {
  if (!press || press.dragging) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.dragging = true;
    call('start_drag');
  }
});
$('pill').addEventListener('pointerup', (e) => {
  if (press && !press.dragging && !e.target.closest('button')) {
    state.alertUntil = 0;
    toggle();
  }
  press = null;
});

$('btn-close').addEventListener('click', () => (invoke ? call('hide') : setView('pill')));
$('btn-settings').addEventListener('click', () => setView('settings'));
$('btn-refresh').addEventListener('click', () => {
  nextArrivals = 0;
  nextStatus = 0;
  tick();
});
$('alerts').addEventListener('click', (e) => {
  const i = e.target.closest('[data-dismiss]')?.dataset.dismiss;
  if (i == null) return;
  state.alerts.splice(Number(i), 1);
  render();
  fitWindow();
});

// Paneldeyken başka yere tıklanırsa kendiliğinden küçül (ayarlar hariç).
window.addEventListener('blur', () => {
  setTimeout(() => {
    if (!document.hasFocus() && state.view === 'main') setView('pill');
  }, 300);
});

// ------------------------------------------------------------------ ayarlar

const form = $('view-settings');

function fillStationList() {
  $('stations').innerHTML = state.stations.map((s) => `<option value="${esc(s.name)}"></option>`).join('');
}

function fillSettings() {
  formError('');
  fillStationList();
  form.from.value = settings.fromName;
  form.to.value = settings.toName;
  form.walk.value = settings.walkMin;
  form.leave.value = settings.leaveAt;
  form.remind.value = settings.remindMin;
  form.notify.checked = settings.notify;
  form.appKey.value = settings.appKey;
  for (const box of form.querySelectorAll('[name="day"]')) box.checked = settings.days.includes(Number(box.value));
  form.autostart.disabled = !invoke;
  call('autostart', {}).then((on) => (form.autostart.checked = Boolean(on)));
  if (!state.stations.length) {
    ensureStations()
      .then(fillStationList)
      .catch(() => formError('TfL istasyon listesini alamadım. İnternetini kontrol edip tekrar aç.'));
  }
}

function formError(text) {
  $('form-error').hidden = !text;
  $('form-error').textContent = text;
  if (text) fitWindow();
}

function findStation(text) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const exact = state.stations.find((s) => s.name.toLowerCase() === q);
  if (exact) return exact;
  const starts = state.stations.filter((s) => s.name.toLowerCase().startsWith(q));
  return starts.length === 1 ? starts[0] : null;
}

const clamp = (n, lo, hi, fallback) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.stations.length) return formError('İstasyon listesi henüz gelmedi, birazdan tekrar dene.');
  const from = findStation(form.from.value);
  const to = findStation(form.to.value);
  if (!from || !to) return formError('İstasyonu listeden seç 🙏');
  if (from.id === to.id) return formError('Nereden ve nereye aynı olamaz 🙂');
  const days = [...form.querySelectorAll('[name="day"]:checked')].map((b) => Number(b.value));

  settings = {
    ...settings,
    fromId: from.id,
    fromName: from.name,
    toId: to.id,
    toName: to.name,
    walkMin: clamp(parseInt(form.walk.value, 10), 0, 90, DEFAULTS.walkMin),
    leaveAt: form.leave.value || DEFAULTS.leaveAt,
    remindMin: clamp(parseInt(form.remind.value, 10), 0, 60, DEFAULTS.remindMin),
    days,
    notify: form.notify.checked,
    appKey: form.appKey.value.trim(),
  };
  store.set('settings', settings);
  if (invoke) call('autostart', { enable: form.autostart.checked });
  tracker = new Tracker();
  state.trip = null;
  state.error = '';
  setView('main');
});

$('btn-cancel').addEventListener('click', () => setView(configured() ? 'main' : 'pill'));
$('btn-quit').addEventListener('click', () => call('quit'));

// ------------------------------------------------------------------ döngü

let nextArrivals = 0;
let nextStatus = 0;

function tick() {
  const now = Date.now();
  const watching = configured() && (isLive(now) || state.view !== 'pill');
  if (watching && now >= nextArrivals) {
    nextArrivals = now + 30_000;
    refreshArrivals();
  }
  if (now >= nextStatus) {
    nextStatus = now + (watching ? 2 : 10) * MIN;
    refreshStatus();
  }
  watchReminders(currentPlan(now), now);
  render();
}

window.addEventListener('online', () => {
  nextArrivals = 0;
  nextStatus = 0;
});

async function start() {
  $('face').innerHTML = FACE_SVG;
  await document.fonts?.ready;
  render();
  if (listen) listen('open-settings', () => setView('settings'));
  await call('ready');
  if (!configured()) setView('settings');
  tick();
  setInterval(tick, 1000);
}

start();
