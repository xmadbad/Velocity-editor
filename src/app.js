// Lizzie arayüzü: TfL'yi yoklar, hapı ve paneli çizer, hatırlatır, değişince haber verir.
import {
  BIKE_OVERHEAD_MIN, DEFAULTS, LEVEL_TEXT, MAX_ACCURACY_M, MIN, Tracker, atTime, atToday,
  bestAlternative, bestJourney, bikeVerdict, buildRoutes, nearestStation, parseHHMM, placeOptions,
  planBNeeded, walkMinutes, chooseTrip, dayMode, fmtDuration, fmtTime, insight,
  nameIndex, nearbyVehicles, parseStatus, plan, stationsFromStopPoints, trainsForTrip,
} from './logic.js';
import { FACE_SVG, MINI_TRAIN } from './face.js';

const API = 'https://api.tfl.gov.uk';
// Lime'ın şehir başına açık GBFS akışı. Londra için yayınlanmıyorsa sessizce vazgeçilir.
const LIME_GBFS = 'https://data.lime.bike/api/partners/v2/gbfs/london/gbfs.json';
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

function loadSettings() {
  const saved = store.get('settings', {});
  if (saved.fromId && !saved.workId) {
    // ilk sürümde "nereden/nereye" vardı: iş → ev
    Object.assign(saved, { workId: saved.fromId, workName: saved.fromName, homeId: saved.toId, homeName: saved.toName });
  }
  delete saved.homePostcode; // yerini ev adresi aldı
  return { ...DEFAULTS, ...saved };
}

let settings = loadSettings();
let tracker = new Tracker();
const configured = () => Boolean(settings.workId && settings.homeId);

const state = {
  stations: store.get('stations', null)?.list || [],
  routes: store.get('routes', null)?.list || [],
  arr: null, // trainsForTrip sonucu + hangi yolculuk için (key)
  journeyKey: '',
  fromId: '', // en son seçilen kalkış durağı (bkz. chooseTrip/prevFromId)
  pos: null, // { lat, lon, accuracy }
  posAt: 0,
  posError: '', // '' | 'denied' | 'vague' | 'unavailable'
  plans: null, // TfL rota planlayıcısından: { key, departAt, bikeMin, trainMin, trainArrive, alt, error }
  lime: null, // yakındaki Lime araçları (akış varsa)
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

// allow300: TfL rota planlayıcısı belirsiz yerler için 300 + seçenek listesi döner.
async function getJSON(url, label, { allow300 = false } = {}) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok && !(allow300 && res.status === 300)) throw Object.assign(new Error(`${label} HTTP ${res.status}`), { http: res.status });
    return await res.json();
  } catch (e) {
    if (e.http || !invoke) throw e;
    return JSON.parse(await invoke('http_get', { url })); // webview'den olmadıysa Rust'tan dene
  }
}

function tfl(path, opts) {
  const sep = path.includes('?') ? '&' : '?';
  return getJSON(API + path + (settings.appKey ? `${sep}app_key=${encodeURIComponent(settings.appKey)}` : ''), 'TfL', opts);
}

async function ensureStations(force = false) {
  const cached = store.get('stations', null);
  const fresh = cached?.list?.some((s) => Number.isFinite(s.lat)) && Date.now() - cached.at < 7 * DAY;
  if (!force && fresh) {
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
    const j = journey();
    if (!j.to) return;
    const preds = await tfl(`/Line/elizabeth/Arrivals/${encodeURIComponent(j.from.id)}`);
    state.arr = {
      key: journeyKey(j),
      ...trainsForTrip(preds, { fromId: j.from.id, toId: j.to.id, routes: state.routes, nameToId: nameIndex(state.stations) }),
    };
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

// ------------------------------------------------------------------ konum

let locating = false;
async function refreshLocation() {
  if (!settings.useLocation || !invoke || locating) return;
  locating = true;
  try {
    const [lat, lon, accuracy] = await invoke('locate');
    state.pos = { lat, lon, accuracy: accuracy >= 0 ? accuracy : 500 };
    state.posAt = Date.now();
    state.posError = state.pos.accuracy > MAX_ACCURACY_M ? 'vague' : '';
    if (!state.stations.some((s) => Number.isFinite(s.lat))) await ensureStations(true).catch(() => {});
  } catch (e) {
    state.posError = String(e).includes('denied') ? 'denied' : 'unavailable';
  } finally {
    locating = false;
    render();
  }
}

// Şu an nereden nereye: konuma (ya da saate) göre seçilen yolculuk.
function journey(now = Date.now()) {
  const fresh = settings.useLocation && state.pos && now - state.posAt < 30 * MIN;
  const j = chooseTrip({ pos: fresh ? state.pos : null, stations: state.stations, routes: state.routes, settings, now, prevFromId: state.fromId });
  state.fromId = j.from.id;
  return j;
}
const journeyKey = (j) => `${j.from.id}>${j.to?.id || ''}`;

// ------------------------------------------------------------------ B planı ve e-bisiklet

const pad2 = (n) => String(n).padStart(2, '0');
const place = (s) => encodeURIComponent(s).replace(/%2C/gi, ',');
const ALT_MODES = 'tube,dlr,overground,national-rail,bus,tram,walking';

// TfL rota planlayıcısına aynı çıkış saati için üç soru: Elizabeth line ile, Elizabeth
// line olmadan (B planı) ve bisikletle. Lime/Voi canlı konumları açık olmadığı için
// e-bisiklet süresi TfL'nin "hızlı" sürücü bisiklet rotasından gelir.
let loadingPlans = false;
async function refreshPlans() {
  if (!configured() || loadingPlans) return;
  const now = Date.now();
  const j = journey(now);
  if (!j.to) return;
  loadingPlans = true;
  // Kapıdan kapıya: bulunduğun yer (ya da iş/ev adresi) → gideceğin adres; yoksa duraklar.
  const latlon = (p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  const here = j.source === 'location' && state.pos ? state.pos : j.fromPlace;
  const from = here ? latlon(here) : j.from.id;
  const to = j.toPlace ? latlon(j.toPlace) : j.to.id;
  const target = currentPlan(now, j)?.target;
  const L = parseHHMM(j.leaveAt) ? atToday(now, j.leaveAt) : now;
  const departAt = target && target.leaveBy > now ? target.leaveBy : Math.max(now, L);
  const d = new Date(departAt);
  const when = `date=${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}&time=${pad2(d.getHours())}${pad2(d.getMinutes())}&timeIs=Departing`;
  const base = `/Journey/JourneyResults/${place(from)}/to/${place(to)}?${when}`;
  const info = { key: journeyKey(j), departAt, bikeMin: NaN, trainMin: NaN, trainArrive: NaN, rail: null, alt: null, error: '' };
  let failure = null;
  const ask = (query) => tfl(`${base}&${query}`).catch((e) => ((failure = e), null));
  try {
    const [rail, other, cycle] = await Promise.all([
      ask(`mode=elizabeth-line,${ALT_MODES}`),
      ask(`mode=${ALT_MODES}`),
      settings.bike ? ask('mode=cycle&cyclePreference=AllTheWay&bikeProficiency=Fast') : null,
    ]);
    const train = bestJourney(rail, 'elizabeth-line');
    const bike = bestJourney(cycle);
    info.trainMin = train ? train.duration : NaN;
    info.trainArrive = train ? train.arrival : NaN;
    info.rail = train;
    info.alt = bestAlternative(other);
    info.bikeMin = bike ? bike.duration + BIKE_OVERHEAD_MIN : NaN;
    if (failure && !rail && !other && !cycle) {
      info.error = /HTTP 300/.test(String(failure.message)) ? 'TfL posta kodunu tanımadı' : friendlyError(failure);
    }
  } finally {
    state.plans = info;
    loadingPlans = false;
    watchPlanB();
    render();
  }
}

const freshPlans = (now = Date.now()) => {
  const pl = state.plans;
  return pl && !pl.error && pl.key === journeyKey(journey(now)) ? pl : null;
};

function currentBike(now = Date.now()) {
  const pl = freshPlans(now);
  if (!settings.bike || !pl) return null;
  return bikeVerdict(pl.bikeMin, pl.trainMin, state.status?.level);
}

// Başka hat önerisi: { alt, needed, fasterBy } — needed: hapta öne çıkar.
function currentAlt(now = Date.now(), p = currentPlan(now)) {
  const pl = freshPlans(now);
  const alt = pl?.alt;
  if (!alt || alt.leaveAt < now - MIN) return null;
  const needed = planBNeeded({
    alt,
    level: state.status?.level,
    hasTrains: Boolean(p?.list.length),
    early: Boolean(p?.early),
    trainArrive: pl.trainArrive,
  });
  const fasterBy = Number.isFinite(pl.trainArrive) ? Math.round((pl.trainArrive - alt.arrive) / MIN) : null;
  return { alt, needed: Boolean(p) && needed, fasterBy };
}

let loadingLime = false;
async function refreshLime() {
  if (!settings.bike || !state.pos || loadingLime || store.get('limeOff', 0) > Date.now()) return;
  loadingLime = true;
  try {
    const index = await getJSON(LIME_GBFS, 'Lime');
    const data = index?.data || {};
    const feeds = data.feeds || Object.values(data)[0]?.feeds || [];
    const url = feeds.find((f) => f.name === 'free_bike_status' || f.name === 'vehicle_status')?.url;
    if (!url) throw new Error('Lime akışı yok');
    state.lime = nearbyVehicles(await getJSON(url, 'Lime'), state.pos);
  } catch {
    state.lime = null;
    store.set('limeOff', Date.now() + DAY); // Londra akışı yok: yarın yine dene
  } finally {
    loadingLime = false;
    render();
  }
}

// Elizabeth line işe yaramıyorsa günde bir kez: hangi hatla (ve/veya Lime/Voi ile) git.
function watchPlanB() {
  const now = Date.now();
  if (!isLive(now)) return;
  const a = currentAlt(now);
  const v = currentBike(now);
  const troubled = ['bad', 'closed'].includes(state.status?.level);
  const bike = v?.suggest && troubled ? v : null;
  if (!a?.needed && !bike) return;
  if (!once(`planb:${today(now)}`)) return;
  const where = journey(now).dir === 'work' ? 'İşe' : 'Eve';
  if (a?.needed) {
    const { alt } = a;
    const extra = bike ? ` Lime/Voi ile ~${bike.bikeMin} dk.` : '';
    say(`🔀 ${alt.lines.join(' → ')}`, `Elizabeth line'a güvenme. ${atTime(alt.leaveAt)} çık, ${fmtTime(alt.arrive)} gibi ${where === 'Eve' ? 'evdesin' : 'iştesin'}.${extra}`, `${atTime(alt.leaveAt)} çık · ${fmtTime(alt.arrive)} varış`);
  } else {
    const train = Number.isFinite(bike.trainMin) ? `, trenle ~${bike.trainMin} dk` : '';
    say('🚲 Lime/Voi alternatifi', `Hat sorunlu. ${where} e-bisikletle ~${bike.bikeMin} dk${train}.`, `Hat sorunlu · ${where.toLowerCase()} ~${bike.bikeMin} dk`);
  }
}
const tripSettings = (j) => ({ ...settings, walkMin: j.walkMin, leaveAt: j.leaveAt });

function whereText(j) {
  if (j.source === 'location') return `📍 Konumuna en yakın durak: ${j.from.name} · ~${j.walkMin} dk yürüme`;
  const fixed = `${j.from.name}, ${j.walkMin} dk yürüme`;
  if (!settings.useLocation) return `📌 Sabit durak: ${fixed}`;
  const why = {
    denied: 'Konum kapalı (Windows Ayarlar › Gizlilik › Konum › masaüstü uygulamalarına izin ver).',
    vague: `Konum çok bulanık (±${Math.round((state.pos?.accuracy || 0) / 1000)} km).`,
    unavailable: 'Konum alınamadı.',
  }[state.posError] || (state.pos ? "Elizabeth line'dan uzaktasın." : 'Konum bekleniyor…');
  return `📍 ${why} Şimdilik sabit durak: ${fixed}`;
}

function friendlyError(e) {
  const msg = String(e?.message || e);
  if (/429/.test(msg)) return 'TfL biraz yoruldu, birazdan tekrar denerim';
  if (/HTTP/.test(msg)) return msg;
  return 'İnternete ulaşamadım';
}

// ------------------------------------------------------------------ plan ve haberler

function currentPlan(now = Date.now(), j = journey(now)) {
  const arr = state.arr;
  if (!arr || arr.key !== journeyKey(j)) return null;
  const uncertain = !arr.trains.length && arr.unknown.length > 0;
  return { ...plan(uncertain ? arr.unknown : arr.trains, now, tripSettings(j)), uncertain };
}

const isLive = (now = Date.now()) => configured() && dayMode(now, tripSettings(journey(now))) === 'live';
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

// short: hapın ikinci satırına sığan özet; uzun metin Windows bildiriminde ve panelde.
function say(title, body, short = body) {
  state.alerts = [{ title, body, short, at: Date.now() }, ...state.alerts].slice(0, 3);
  state.alertUntil = Date.now() + 25_000;
  if (settings.notify) call('notify', { title, body });
  render();
}

function planLine(p) {
  const t = p?.target;
  return t ? `Yeni plan: ${atTime(t.leaveBy)} çık, ${fmtTime(t.time)} trenine bin.` : 'Şimdilik başka tren görünmüyor.';
}

const planShort = (p) => (p?.target ? `${atTime(p.target.leaveBy)} çık` : 'başka tren yok');

function watchForChanges() {
  const now = Date.now();
  if (!isLive(now)) return;
  const p = currentPlan(now);
  for (const ev of tracker.update(p, now)) {
    if (ev.type === 'shift' && ev.delta > 0) {
      say(`😿 Trenin ${ev.delta} dk gecikti`, `${fmtTime(ev.from.base)} treni artık ${fmtTime(ev.to.time)} görünüyor. ${planLine(p)}`, `${fmtTime(ev.from.base)} → ${fmtTime(ev.to.time)} · ${planShort(p)}`);
    } else if (ev.type === 'shift') {
      say(`⏩ Trenin ${-ev.delta} dk erkene kaydı`, `${fmtTime(ev.from.base)} treni artık ${fmtTime(ev.to.time)}. ${planLine(p)}`, `${fmtTime(ev.from.base)} → ${fmtTime(ev.to.time)} · ${planShort(p)}`);
    } else if (ev.type === 'gone') {
      say(`⚠️ ${fmtTime(ev.from.time)} treni düştü`, `Listeden çıktı, iptal olmuş olabilir. ${planLine(p)}`, `İptal olabilir · ${planShort(p)}`);
    }
  }
}

function watchReminders(p, now) {
  const t = p?.target;
  if (!t || !isLive(now) || now < p.L - 45 * MIN) return;
  const day = `${journey(now).dir}:${today(now)}`;
  const remindMin = Number(settings.remindMin) || 0;
  if (remindMin > 1 && t.slack <= remindMin && t.slack > 1.5 && once(`remind:${day}`)) {
    say('🎒 Toparlanma vakti', `${fmtTime(t.time)} trenine yetişmek için ${atTime(t.leaveBy)} çık (${fmtDuration(Math.ceil(t.slack))} kaldı).`, `${fmtTime(t.time)} için ${atTime(t.leaveBy)} çık`);
  }
  if (t.slack <= 1 && t.slack >= -0.5 && once(`go:${day}`)) {
    const next = p.alt ? ` Kaçırırsan sonraki ${fmtTime(p.alt.time)}.` : '';
    say('🏃 Çıkış vakti!', `${fmtTime(t.time)} treni (${t.dest}) için şimdi çık.${next}`, `${fmtTime(t.time)} → ${t.dest}`);
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
  if (s.level === 'good') say('✨ Hat düzeldi', 'Elizabeth line yeniden iyi serviste. Plan normale döndü.', 'Plan normale döndü');
  else say(`${s.level === 'minor' ? '😿' : '🚨'} Hat: ${LEVEL_TEXT[s.level]}`, s.reason || s.desc, 'Detay için tıkla');
  nextPlans = 0; // hat bozulduysa B planını ve bisikleti hemen tazele
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
  const j = journey(now);
  const mode = dayMode(now, tripSettings(j));
  const L = atToday(now, j.leaveAt);
  const goal = j.dir === 'work' ? 'İşe çıkış' : 'Eve dönüş';
  const statusLine = `Elizabeth line · ${LEVEL_TEXT[state.status?.level || 'unknown']}`;
  const watching = mode === 'live' || state.view !== 'pill';

  if (!watching) {
    if (mode === 'before') {
      return { headline: `${goal} ${fmtTime(L)}`, sub: statusLine, badge: shortDuration((L - now) / MIN), badgeClass: 's-idle', kind: 'calm' };
    }
    const weekend = [0, 6].includes(new Date(now).getDay());
    const headline = mode === 'off' ? (weekend ? 'İyi hafta sonları 🌸' : 'Bugün izinlisin 🌸')
      : j.dir === 'work' ? 'Evdesin 🏡' : 'Bugünlük bu kadar 🌙';
    return { headline, sub: statusLine, kind: 'sleepy' };
  }

  const p = currentPlan(now, j);
  const b = currentAlt(now, p);
  if (b?.needed) {
    // Elizabeth line yok ya da işe yaramıyor: en mantıklı başka hat.
    const mins = (b.alt.leaveAt - now) / MIN;
    const sub = `🔀 ${b.alt.lines.join(' → ')} · ${fmtTime(b.alt.arrive)} varış`;
    return mins > 1
      ? { headline: `${atTime(b.alt.leaveAt)} çık`, sub, badge: fmtDuration(Math.ceil(mins)), badgeClass: mins < 3 ? 's-now' : 's-relaxed', kind: 'worried', plan: p }
      : { headline: 'Şimdi çık 🎒', sub, kind: 'alert', plan: p };
  }
  if (!p) {
    return state.error
      ? { headline: 'Bağlantı yok 📡', sub: state.error, kind: 'sleepy' }
      : { headline: 'Lizzie bakıyor…', sub: `${j.from.name} → ${j.to?.name || ''}`, kind: 'calm' };
  }

  const t = p.target;
  if (!t) {
    if (p.early) {
      return { headline: `${goal} ${fmtTime(L)}`, sub: 'Tahminler birazdan gelir', badge: shortDuration((L - now) / MIN), badgeClass: 's-idle', kind: 'calm', plan: p };
    }
    const v = currentBike(now);
    const sub = v ? `🚲 Lime/Voi ile ~${v.bikeMin} dk` : state.error || statusLine;
    return { headline: 'Tren görünmüyor 🤔', sub, kind: 'worried', plan: p };
  }

  const stale = state.error && now - state.fetchedAt > 3 * MIN ? `📡 ${state.error} · ${ago(now - state.fetchedAt)}` : '';
  const v = currentBike(now);
  const troubled = ['bad', 'closed'].includes(state.status?.level);
  const bikeHint = v?.suggest && troubled ? `🚲 Lime/Voi ile ~${v.bikeMin} dk` : '';
  const where = stale || bikeHint || `${fmtTime(t.time)} → ${t.dest}`;
  if (t.state === 'run') {
    const sub = p.alt ? `ya da ${fmtTime(p.alt.time)}, ${atTime(p.alt.leaveBy)} çık` : where;
    return { headline: 'Koş! 🏃', sub, badge: 'hemen', badgeClass: 's-run', kind: 'alert', shake: true, plan: p };
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
  setText($('sub'), a ? a.short : m.sub || '');
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
  // Panelde yalnızca en son ve taze (15 dk) uyarı; gerisi zaten kartlarda yazıyor.
  setHTML($('alerts'), state.alerts
    .slice(0, 1)
    .filter((a) => now - a.at < 15 * MIN)
    .map((a) => `<div class="alert"><b>${esc(a.title)}<time>${fmtTime(a.at)}</time></b><span>${esc(a.body)}</span><button data-dismiss="0" title="Kapat">×</button></div>`)
    .join(''));

  const s = state.status || { level: 'unknown', desc: '', reason: '' };
  const emoji = { good: '✨', minor: '😿', bad: '🚨', closed: '⛔', unknown: '🤔' }[s.level];
  $('status').className = `status ${s.level}`;
  setText($('status-title'), `Elizabeth line · ${LEVEL_TEXT[s.level]} ${emoji}`);
  const showDesc = s.level !== 'good' && s.desc && !s.reason.toLowerCase().startsWith(s.desc.toLowerCase());
  setText($('status-reason'), [showDesc ? s.desc : '', s.reason].filter(Boolean).join(' — '));

  const j = journey(now);
  setText($('route'), configured() && j.to ? `${j.from.name} → ${j.to.name}` : '');
  setText($('where'), configured() ? whereText(j) : '');

  const p = m.plan || currentPlan(now);
  const tip = p ? insight(p) : '';
  $('insight').hidden = !tip;
  setText($('insight'), tip ? `💡 ${tip}` : '');
  renderRoute(now, p, j);
  renderBike(now, j);

  const rows = (p?.list || []).slice(0, 6).map((t) => `
    <li class="s-${t.state}${p.target?.key === t.key ? ' is-target' : ''}">
      <b class="t">${fmtTime(t.time)}</b>
      <span class="d">${esc(t.dest)}</span>
      <span class="chip" title="${STATE_TEXT[t.state]}">${atTime(t.leaveBy)} çık</span>
    </li>`);
  const empty = !configured() ? 'Önce ayarlardan durakları seç ⚙' : p ? 'Şu an yetişebileceğin tren görünmüyor' : state.error || 'Yükleniyor…';
  setHTML($('trains'), rows.length ? rows.join('') : `<li class="empty">${esc(empty)}</li>`);

  $('note').hidden = !p?.uncertain;
  setText($('note'), p?.uncertain ? '⚠ Rota bilgisi eşleşmedi, bu duraktaki tüm trenleri gösteriyorum.' : '');

  const parts = [];
  if (state.fetchedAt) parts.push(`↻ ${ago(now - state.fetchedAt)}`);
  if (state.arr) parts.push(`${state.arr.total} tahmin, ${state.arr.trains.length} uygun`);
  if (state.error) parts.push(state.error);
  setText($('updated'), parts.join(' · '));
}

// Önerilen yolun adım adım tarifi: Elizabeth line'la ya da (gerekiyorsa) B planıyla.
function renderRoute(now, p, j) {
  const pl = freshPlans(now);
  const a = currentAlt(now, p);
  const useAlt = a && (a.needed || a.fasterBy >= 5);
  const r = useAlt ? a.alt : pl?.rail && { ...pl.rail, arrive: pl.rail.arrival };
  $('route-card').hidden = !r?.steps?.length;
  if ($('route-card').hidden) return;
  $('route-card').classList.toggle('alt', Boolean(useAlt));

  // Elizabeth line ile gidiyorsak ilk binişi canlı tahmindeki hedef trenle eşitle.
  const target = !useAlt && p?.target;
  const steps = r.steps.map((s) => ({ ...s }));
  const first = steps.find((s) => s.kind === 'ride');
  if (target && first?.mode === 'elizabeth-line' && first.from === j.from.name) first.dep = target.time;
  const leaveAt = target ? target.leaveBy : r.leaveAt;

  setText($('route-title'), `${useAlt ? '🔀 B planı' : '🧭 Yol tarifi'} · ${atTime(leaveAt)} çık · ${fmtTime(r.arrive)} varış`);
  setText($('route-why'), useAlt ? (a.needed ? "Elizabeth line'a güvenme" : `Elizabeth'ten ${a.fasterBy} dk erken`) : '');
  const dest = j.toPlace ? (j.dir === 'work' ? 'iş' : 'ev') : '';
  setHTML($('steps'), steps.map((s, i) => {
    if (s.kind === 'walk') {
      const to = i === steps.length - 1 && dest ? dest : s.to;
      return `<li class="walk"><i>🚶</i><span>${s.minutes} dk yürü${to ? ` → ${esc(to)}` : ''}</span></li>`;
    }
    const head = `<b>${s.transfer ? 'Aktar: ' : ''}${esc(s.line)}</b>${s.direction ? ` · ${esc(s.direction)} yönü` : ''}${s.disrupted ? ' ⚠️' : ''}`;
    const detail = `Bin ${fmtTime(s.dep)} ${esc(s.from)} → İn ${fmtTime(s.arr)} ${esc(s.to)}${s.stops ? ` · ${s.stops} durak` : ''}`;
    return `<li class="ride"><i>${s.icon}</i><span>${head}<br><small>${detail}</small></span></li>`;
  }).join(''));
}

function renderBike(now, j) {
  const b = state.plans;
  const v = currentBike(now);
  const card = $('bike');
  card.hidden = !settings.bike || !configured() || (!v && !b?.error);
  if (card.hidden) return;
  card.classList.toggle('suggest', Boolean(v?.suggest));
  if (!v) {
    setText($('bike-title'), `🚲 E-bisiklet: ${b.error}`);
    setText($('bike-sub'), '');
    return;
  }
  const train = Number.isFinite(v.trainMin) ? ` · 🚆 Tren ~${v.trainMin} dk` : '';
  setText($('bike-title'), `🚲 Lime/Voi ~${v.bikeMin} dk${train}`);
  const verdict = v.trainMin == null ? ''
    : v.faster === 'bike' ? `Lime/Voi ${v.diff} dk daha hızlı ✨`
    : v.faster === 'train' ? `Tren ${v.diff} dk daha hızlı`
    : 'İkisi de aynı, keyfine göre 😌';
  const lime = state.lime
    ? state.lime.count ? `Lime: 400 m içinde ${state.lime.count} araç, en yakını ${state.lime.nearestM} m` : 'Lime: 400 m içinde boş araç yok'
    : '';
  const when = `${atTime(b.departAt)} çıkarsan ${j.dir === 'work' ? 'işe' : 'eve'}`;
  setText($('bike-sub'), [verdict ? `${when}: ${verdict}` : when, lime].filter(Boolean).join(' · '));
}

function ago(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} sn önce` : `${Math.round(s / 60)} dk önce`;
}

let fitted = '';
const appSize = () => {
  const r = $('app').getBoundingClientRect();
  return { width: Math.ceil(r.width), height: Math.ceil(r.height) };
};

function render() {
  const now = Date.now();
  const m = renderPill(now);
  if (state.view === 'main') renderMain(now, m);
  // İçerik büyüyüp küçüldükçe pencere de ona uysun.
  const { width, height } = appSize();
  if (`${width}x${height}` !== fitted) fitWindow();
}

// ------------------------------------------------------------------ pencere ve görünüm

async function fitWindow() {
  if (!invoke) return;
  const { width, height } = appSize();
  fitted = `${width}x${height}`;
  await call('resize', { width, height, growUp: Boolean(state.growUp), growLeft: Boolean(state.growLeft) });
}

async function setView(view) {
  if (view !== 'pill' && state.view === 'pill') {
    // Hap hangi köşeye yakınsa panel o köşeden uzağa açılsın; kapanırken aynı köşeye tutun.
    state.growUp = window.screenY + window.innerHeight / 2 > (screen.availTop || 0) + screen.availHeight / 2;
    state.growLeft = window.screenX + window.innerWidth / 2 > (screen.availLeft || 0) + screen.availWidth / 2;
    $('app').classList.toggle('up', state.growUp);
  }
  $('app').classList.toggle('open', view !== 'pill');
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
    state.growLeft = null;
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

// Ev ve iş yeri seçimi: yazıp Enter/🔍 (TfL'de arar) ya da oradayken 📍.
const picked = { home: null, work: null };
const placeBox = (kind) => form.querySelector(`.place[data-kind="${kind}"]`);

function showPicked(kind) {
  const p = picked[kind];
  const el = placeBox(kind).querySelector('.picked');
  const st = p && nearestStation(p, state.stations);
  el.classList.toggle('ok', Boolean(p));
  el.textContent = !p ? 'Yaz ve Enter’a bas ya da oradayken 📍'
    : st ? `✓ En yakın durak ${st.name}, ~${walkMinutes(st.d)} dk yürüme` : `✓ ${p.label}`;
}

function pickPlace(kind, place) {
  picked[kind] = { label: place.label, lat: place.lat, lon: place.lon };
  placeBox(kind).querySelector('input').value = place.label;
  placeBox(kind).querySelector('.results').hidden = true;
  showPicked(kind);
  fitWindow();
}

async function searchPlace(kind) {
  const box = placeBox(kind);
  const q = box.querySelector('input').value.trim();
  const list = box.querySelector('.results');
  if (q.length < 2) return;
  list.hidden = false;
  list.innerHTML = '<li class="muted">Aranıyor…</li>';
  fitWindow();
  try {
    if (!state.stations.length) await ensureStations().catch(() => {});
    const resp = await tfl(`/Journey/JourneyResults/${encodeURIComponent(q)}/to/51.5074,-0.1278`, { allow300: true });
    const options = placeOptions(resp);
    list.innerHTML = options.length
      ? options.map((o, i) => `<li><button type="button" data-i="${i}">${esc(o.label)}</button></li>`).join('')
      : '<li class="muted">Bulamadım, posta kodunu dene</li>';
    list.onclick = (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      if (i != null) pickPlace(kind, options[Number(i)]);
    };
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(friendlyError(e))}</li>`;
  }
  fitWindow();
}

async function pickHere(kind) {
  if (!invoke) return formError('Konum yalnızca uygulamada çalışır');
  try {
    const [lat, lon] = await invoke('locate');
    if (!state.stations.length) await ensureStations().catch(() => {});
    const st = nearestStation({ lat, lon }, state.stations);
    pickPlace(kind, { label: st ? `Konumum (${st.name} yakını)` : 'Konumum', lat, lon });
  } catch (e) {
    formError(String(e).includes('denied') ? 'Konum kapalı: Windows Ayarlar › Gizlilik › Konum' : 'Konum alınamadı');
  }
}

form.addEventListener('click', (e) => {
  const btn = e.target.closest('.place [data-act]');
  if (!btn) return;
  const kind = btn.closest('.place').dataset.kind;
  if (btn.dataset.act === 'search') searchPlace(kind);
  else pickHere(kind);
});
form.addEventListener('keydown', (e) => {
  const box = e.target.closest('.place');
  if (box && e.key === 'Enter') {
    e.preventDefault();
    searchPlace(box.dataset.kind);
  }
});
form.addEventListener('input', (e) => {
  const box = e.target.closest('.place');
  if (!box) return;
  picked[box.dataset.kind] = null; // yazı değişti: yeniden seçilmeli
  showPicked(box.dataset.kind);
});

function fillSettings() {
  formError('');
  fillStationList();
  for (const kind of ['home', 'work']) {
    picked[kind] = settings[kind];
    placeBox(kind).querySelector('input').value = settings[kind]?.label || '';
    placeBox(kind).querySelector('.results').hidden = true;
    showPicked(kind);
  }
  // Adres seçilmemişse (eski kurulum) ya da durak elle sabitlendiyse Gelişmiş'te görünsün.
  form.homeStation.value = settings.homeFixed || !settings.home ? settings.homeName : '';
  form.workStation.value = settings.workFixed || !settings.work ? settings.workName : '';
  form.useLocation.checked = settings.useLocation;
  form.useLocation.disabled = !invoke;
  form.bike.checked = settings.bike;
  form.walk.value = settings.walkMin;
  form.leave.value = settings.leaveAt;
  form.morning.value = settings.morningAt;
  form.remind.value = settings.remindMin;
  form.notify.checked = settings.notify;
  form.appKey.value = settings.appKey;
  for (const box of form.querySelectorAll('[name="day"]')) box.checked = settings.days.includes(Number(box.value));
  form.autostart.disabled = !invoke;
  call('autostart', {}).then((on) => (form.autostart.checked = Boolean(on)));
  if (!state.stations.some((s) => Number.isFinite(s.lat))) {
    ensureStations(true)
      .then(() => {
        fillStationList();
        showPicked('home');
        showPicked('work');
      })
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
  const fixed = (input) => (input.value.trim() ? findStation(input.value) : null);
  const homeFixed = fixed(form.homeStation);
  const workFixed = fixed(form.workStation);
  if ((form.homeStation.value.trim() && !homeFixed) || (form.workStation.value.trim() && !workFixed)) {
    return formError('Durağı listeden seç ya da boş bırak 🙏');
  }
  if (!picked.home && !homeFixed) return formError('Evini seç 🏡 (yaz + Enter ya da 📍)');
  if (!picked.work && !workFixed) return formError('İş yerini seç 💼 (yaz + Enter ya da 📍)');
  // Duraklar adresten: birbirine aktarmasız giden en yakın Elizabeth line durakları.
  const opts = (towardsId) => ({ routes: state.routes, towardsId });
  let work = workFixed || nearestStation(picked.work, state.stations);
  const home = homeFixed || nearestStation(picked.home, state.stations, opts(work?.id));
  if (!workFixed && picked.work) work = nearestStation(picked.work, state.stations, opts(home?.id));
  if (!work || !home) return formError('Durak listesi gelmedi, birazdan tekrar dene.');
  if (work.id === home.id) return formError('Ev ve iş aynı durağa düşüyor 🙂');
  const days = [...form.querySelectorAll('[name="day"]:checked')].map((b) => Number(b.value));

  settings = {
    ...settings,
    workId: work.id,
    workName: work.name,
    homeId: home.id,
    homeName: home.name,
    home: picked.home,
    work: picked.work,
    homeFixed: Boolean(homeFixed),
    workFixed: Boolean(workFixed),
    useLocation: form.useLocation.checked,
    walkMin: clamp(parseInt(form.walk.value, 10), 0, 90, DEFAULTS.walkMin),
    leaveAt: form.leave.value || DEFAULTS.leaveAt,
    morningAt: form.morning.value,
    bike: form.bike.checked,
    remindMin: clamp(parseInt(form.remind.value, 10), 0, 60, DEFAULTS.remindMin),
    days,
    notify: form.notify.checked,
    appKey: form.appKey.value.trim(),
  };
  store.set('settings', settings);
  if (invoke) call('autostart', { enable: form.autostart.checked });
  state.journeyKey = '';
  state.error = '';
  state.plans = null;
  nextLocate = 0;
  setView('main');
});

$('btn-cancel').addEventListener('click', () => setView(configured() ? 'main' : 'pill'));
$('btn-quit').addEventListener('click', () => call('quit'));

// ------------------------------------------------------------------ döngü

let nextArrivals = 0;
let nextStatus = 0;
let nextLocate = 0;
let nextPlans = 0;
let nextLime = 0;

function tick() {
  const now = Date.now();
  // Yolculuk değiştiyse (başka bir yere geçtin, sabah oldu…) baştan bak.
  const key = configured() ? journeyKey(journey(now)) : '';
  if (key !== state.journeyKey) {
    state.journeyKey = key;
    tracker = new Tracker();
    nextArrivals = 0;
    nextPlans = 0;
  }
  const watching = configured() && (isLive(now) || state.view !== 'pill');
  if (configured() && settings.useLocation && now >= nextLocate) {
    nextLocate = now + (watching ? 5 : 15) * MIN;
    refreshLocation();
  }
  if (watching && now >= nextArrivals) {
    nextArrivals = now + 30_000;
    refreshArrivals();
  }
  if (now >= nextStatus) {
    nextStatus = now + (watching ? 2 : 10) * MIN;
    refreshStatus();
  }
  if (watching && now >= nextPlans && (state.arr || state.error)) {
    // Elizabeth line sorunluyken B planını daha sık tazele.
    const shaky = ['bad', 'closed'].includes(state.status?.level) || (state.arr && !currentPlan(now)?.list.length);
    nextPlans = now + (shaky ? 3 : 10) * MIN;
    refreshPlans();
  }
  if (settings.bike && state.view === 'main' && state.pos && now >= nextLime) {
    nextLime = now + 3 * MIN;
    refreshLime();
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
