// Lizzie'nin beyni: DOM'a dokunmayan saf fonksiyonlar.
// TfL verisini süzer, "kaçta çıkmalıyım?" sorusunu hesaplar, değişiklikleri yakalar.
// Hem uygulama (app.js) hem testler (tests/*.test.js) burayı kullanır.

export const LINE = 'elizabeth';
export const MIN = 60_000;

// ---------------------------------------------------------------- istasyonlar

export function cleanStationName(name = '') {
  const cleaned = String(name)
    .trim()
    .replace(/\s+(Rail|Underground|Elizabeth line|Elizabeth Line|DLR)\s+Station$/i, '')
    .replace(/\s+Station$/i, '')
    .replace(/\s*\((London|Elizabeth line|Crossrail)\)$/i, '')
    .replace(/^London\s+/i, '')
    .trim();
  return cleaned || String(name).trim();
}

const normId = (id) => String(id || '').trim().toUpperCase();
const normName = (name) => cleanStationName(name).toLowerCase();

// /Line/elizabeth/StopPoints -> [{ id, name }] (isme göre sıralı, tekrar yok)
export function stationsFromStopPoints(stopPoints) {
  const byId = new Map();
  for (const sp of stopPoints || []) {
    const id = normId(sp.naptanId || sp.id);
    const name = cleanStationName(sp.commonName || sp.name);
    if (id && name && !byId.has(id)) byId.set(id, { id, name });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function nameIndex(stations) {
  const idx = {};
  for (const s of stations || []) idx[normName(s.name)] = s.id;
  return idx;
}

// ---------------------------------------------------------------- rotalar

// /Line/elizabeth/Route/Sequence/{inbound,outbound} yanıtlarından
// istasyon-id dizileri çıkarır. Hat simetrik olduğu için her dizinin tersi de eklenir.
export function buildRoutes(sequences) {
  const routes = [];
  const seen = new Set();
  const add = (ids) => {
    const clean = ids.map(normId).filter(Boolean);
    if (clean.length < 2) return;
    for (const arr of [clean, [...clean].reverse()]) {
      const key = arr.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        routes.push(arr);
      }
    }
  };
  for (const seq of sequences || []) {
    for (const r of seq?.orderedLineRoutes || []) add(r.naptanIds || []);
    for (const path of branchPaths(seq?.stopPointSequences || [])) add(path);
  }
  return routes;
}

// stopPointSequences dallarını (branchId/nextBranchIds) uçtan uca yollara çevirir.
function branchPaths(sequences) {
  const byId = new Map(sequences.map((s) => [s.branchId, s]));
  const stops = (s) => (s.stopPoint || []).map((p) => p.id || p.stationId);
  const starts = sequences.filter((s) => !(s.prevBranchIds || []).some((id) => byId.has(id)));
  const out = [];
  const walk = (seq, acc, depth) => {
    const path = acc.concat(stops(seq));
    const next = (seq.nextBranchIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (!next.length || depth > 12) out.push(path);
    else for (const n of next) walk(n, path, depth + 1);
  };
  for (const s of starts) walk(s, [], 0);
  return out;
}

// Bu rota üzerinde, fromId'den kalkıp destId'ye giden tren toId'de durur mu?
export function servesTrip(route, fromId, toId, destId) {
  const o = route.indexOf(fromId);
  const t = route.indexOf(toId);
  const d = route.indexOf(destId);
  return o >= 0 && t > o && d >= t;
}

// ---------------------------------------------------------------- trenler

// /Line/elizabeth/Arrivals/{fromId} tahminlerini "beni eve götüren trenler"e süzer.
// Rota bilgisi bir trene karar veremezse o tren `unknown`a düşer; UI, hiç
// kesin tren yoksa bunları uyarıyla gösterir (hiç göstermemekten iyidir).
export function trainsForTrip(predictions, { fromId, toId, routes = [], nameToId = {} }) {
  const from = normId(fromId);
  const to = normId(toId);
  const known = new Set(routes.flat());
  const yes = [];
  const unknown = [];
  const seen = new Set();
  let total = 0;

  for (const p of predictions || []) {
    if (p.lineId && p.lineId !== LINE) continue;
    const time = Date.parse(p.expectedArrival);
    if (!Number.isFinite(time)) continue;
    total++;

    const dest = cleanStationName(p.destinationName || p.towards || '');
    const candidates = [normId(p.destinationNaptanId), nameToId[normName(dest)]].filter(Boolean);
    const destId = candidates[0] || '';
    if (destId === from) continue; // burada biten tren

    const dedupe = `${destId || dest}|${Math.round(time / MIN)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const train = {
      key: `${p.vehicleId || ''}|${destId || dest}|${Math.round(time / MIN)}`,
      vehicleId: p.vehicleId || '',
      time,
      dest: dest || '?',
      destId,
      platform: cleanPlatform(p.platformName),
    };

    const decidable = candidates.filter((id) => known.has(id));
    if (!decidable.length) unknown.push(train);
    else if (decidable.some((id) => routes.some((r) => servesTrip(r, from, to, id)))) yes.push(train);
  }

  const byTime = (a, b) => a.time - b.time;
  return { trains: yes.sort(byTime), unknown: unknown.sort(byTime), total };
}

function cleanPlatform(name) {
  const s = String(name || '').trim();
  if (!s || s === 'null') return '';
  const m = /platform\s*([A-Z0-9]+)/i.exec(s);
  return m ? m[1] : s.length <= 3 ? s : '';
}

// ---------------------------------------------------------------- hat durumu

const LEVEL_OF = {
  10: 'good', 18: 'good', 19: 'good', 12: 'good', 13: 'good',
  0: 'minor', 7: 'minor', 9: 'minor', 14: 'minor', 15: 'minor', 17: 'minor',
  3: 'bad', 5: 'bad', 6: 'bad', 8: 'bad', 11: 'bad',
  1: 'closed', 2: 'closed', 4: 'closed', 16: 'closed', 20: 'closed',
};
const RANK = { good: 0, minor: 1, bad: 2, closed: 3 };

export const LEVEL_TEXT = {
  good: 'İyi servis',
  minor: 'Küçük aksaklıklar',
  bad: 'Ciddi aksaklık',
  closed: 'Kapalı / durduruldu',
  unknown: 'Durum bilinmiyor',
};

// /Line/elizabeth/Status -> { level, desc, reason }
export function parseStatus(resp) {
  const line = (resp || []).find((l) => l.id === LINE) || (resp || [])[0];
  const statuses = line?.lineStatuses || [];
  if (!statuses.length) return { level: 'unknown', desc: LEVEL_TEXT.unknown, reason: '' };

  let level = 'good';
  let reason = '';
  const descs = [];
  for (const s of statuses) {
    const l = LEVEL_OF[s.statusSeverity] || 'minor';
    if (RANK[l] > RANK[level]) {
      level = l;
      reason = s.reason || reason;
    } else if (!reason && s.reason && l !== 'good') {
      reason = s.reason;
    }
    if (s.statusSeverityDescription && !descs.includes(s.statusSeverityDescription)) {
      descs.push(s.statusSeverityDescription);
    }
  }
  return { level, desc: descs.join(' + ') || LEVEL_TEXT[level], reason: tidyReason(reason) };
}

function tidyReason(text) {
  return String(text || '')
    .replace(/^\s*ELIZABETH LINE:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- zaman

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1];
  const min = +m[2];
  return h < 24 && min < 60 ? { h, min } : null;
}

export function atToday(now, hhmm) {
  const t = parseHHMM(hhmm) || { h: 18, min: 0 };
  const d = new Date(now);
  d.setHours(t.h, t.min, 0, 0);
  return d.getTime();
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Türkçe bulunma eki: saat nasıl okunuyorsa öyle çekimlenir.
// 17:59 -> "elli dokuz" -> 'da'  |  18:00 -> "on sekiz" -> 'de'  |  18:04 -> "dört" -> 'te'
const UNIT_SUFFIX = ['da', 'de', 'de', 'te', 'te', 'te', 'da', 'de', 'de', 'da'];
const TENS_SUFFIX = ['da', 'da', 'de', 'da', 'ta', 'de'];

export function locSuffix(h, m) {
  const n = m === 0 ? h : m;
  if (n === 0) return 'da'; // sıfırda
  return n % 10 ? UNIT_SUFFIX[n % 10] : TENS_SUFFIX[Math.floor(n / 10)];
}

// "17:59'da"
export function atTime(ms) {
  const d = new Date(ms);
  return `${fmtTime(ms)}'${locSuffix(d.getHours(), d.getMinutes())}`;
}

export function fmtDuration(min) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} sa ${r} dk` : `${h} sa`;
}

// ---------------------------------------------------------------- plan

export const DEFAULTS = {
  fromId: '',
  fromName: '',
  toId: '',
  toName: '',
  walkMin: 8,
  leaveAt: '18:00',
  remindMin: 5,
  days: [1, 2, 3, 4, 5],
  notify: true,
  appKey: '',
};

// Treni yakalamak için masadan kalkmana kalan dakika -> rahat / şimdi / koş / kaçtı
export function stateFor(slackMin) {
  if (slackMin < -1) return 'missed';
  if (slackMin < 1) return 'run';
  if (slackMin < 3) return 'now';
  return 'relaxed';
}

// Günün hangi kısmındayız? 'live' = çıkış saatinin etrafında, veriyi sık çek.
export function dayMode(now, s) {
  const day = new Date(now).getDay();
  if (!(s.days || DEFAULTS.days).includes(day)) return 'off';
  const L = atToday(now, s.leaveAt);
  if (now < L - 90 * MIN) return 'before';
  if (now > L + 180 * MIN) return 'after';
  return 'live';
}

// Asıl soru: "Kaçta çıkayım?"
//   - Normal çıkış saatinden (L) önceysek: L'den en fazla 3 dk önce çıkarak
//     yetişebileceğin ilk tren hedeftir.
//   - L geçtiyse: hâlâ yetişebileceğin ilk tren hedeftir.
// `atL`: tam L'de çıksaydın hangi trene biner, perona varıp kaç dk beklerdin.
export function plan(trains, now, s) {
  const walk = (Number(s.walkMin) || 0) * MIN;
  const L = atToday(now, s.leaveAt);
  const list = trains
    .map((t) => {
      const leaveBy = t.time - walk;
      const slack = (leaveBy - now) / MIN;
      return { ...t, leaveBy, slack, state: stateFor(slack) };
    })
    .filter((t) => t.state !== 'missed');

  const early = now < L - 3 * MIN;
  const target = early ? list.find((t) => t.leaveBy >= L - 3 * MIN) : list[0];
  const alt = target ? list[list.indexOf(target) + 1] : undefined;

  let atL = null;
  if (now < L) {
    const platformAt = L + walk;
    const train = list.find((t) => t.time >= platformAt);
    if (train) atL = { train, platformAt, waitMin: (train.time - platformAt) / MIN };
  }

  return { list, target, alt, atL, L, early };
}

// "18:00'de çıksam olur mu?" sorusunun tek cümlelik cevabı.
export function insight(p) {
  const { target, atL, L } = p;
  if (!target || !atL || !p.early) return '';
  if (atL.train.key !== target.key) {
    const gain = Math.round((atL.train.time - target.time) / MIN);
    return `${fmtTime(L)} yerine ${atTime(target.leaveBy)} çıkarsan ${fmtTime(target.time)} trenine binersin, eve ${gain} dk erken varırsın.`;
  }
  const wait = Math.round(atL.waitMin);
  if (wait >= 3) {
    return `${atTime(L)} çıkarsan perona ${fmtTime(atL.platformAt)} gibi varıp ${wait} dk beklersin. ${atTime(target.leaveBy)} çık, beklemeden bin.`;
  }
  return `${fmtTime(L)} çıkışın ${fmtTime(target.time)} trenine tam denk geliyor ✨`;
}

// ---------------------------------------------------------------- değişiklik takibi

// Hedef treni anketten ankete izler. Saati ≥2 dk kayarsa 'shift', iki ankettir
// listede yoksa 'gone' olayı üretir. Vakit geçtiği için hedef değişirse sessiz kalır.
export class Tracker {
  constructor() {
    this.cur = null;
    this.missing = 0;
  }

  update(p, now) {
    const events = [];
    const fresh = (t) => (t ? { ...t, base: t.time } : null);
    const cur = this.cur;

    if (!cur || cur.time - now <= MIN) {
      this.cur = fresh(p.target);
      this.missing = 0;
      return events;
    }

    const match = findMatch(p.list, cur);
    if (match) {
      this.missing = 0;
      const delta = Math.round((match.time - cur.base) / MIN);
      if (Math.abs(delta) >= 2) {
        events.push({ type: 'shift', from: { ...cur }, to: match, delta });
        cur.base = match.time;
      }
      Object.assign(cur, { time: match.time, key: match.key, vehicleId: cur.vehicleId || match.vehicleId });
      if (p.target && p.target.key !== match.key) this.cur = fresh(p.target); // hedef başka trene geçti
      return events;
    }

    this.missing++;
    if (this.missing >= 2) {
      events.push({ type: 'gone', from: cur, next: p.target || null });
      this.cur = fresh(p.target);
      this.missing = 0;
    }
    return events;
  }
}

// Aracı biliyorsak önce onu ararız; bilmiyorsak aynı yöne giden en yakın saatli
// treni aynı tren sayarız. Aracı bilinen bir tren için uzak bir eşleşme kabul
// edilmez — o durumda tren gerçekten listeden düşmüştür.
function findMatch(list, cur) {
  if (cur.vehicleId) {
    const exact = list.find((t) => t.vehicleId === cur.vehicleId && t.dest === cur.dest);
    if (exact) return exact;
  }
  const maxLate = (cur.vehicleId ? 3 : 15) * MIN;
  // Rötar erken gelmekten çok daha olası: geriye kayma iki kat pahalı sayılır.
  const lag = (t) => (t.time >= cur.time ? t.time - cur.time : 2 * (cur.time - t.time));
  let best = null;
  for (const t of list) {
    if (t.dest !== cur.dest) continue;
    if (cur.vehicleId && t.vehicleId && t.vehicleId !== cur.vehicleId) continue;
    if (t.time < cur.time - 3 * MIN || t.time > cur.time + maxLate) continue;
    if (!best || lag(t) < lag(best)) best = t;
  }
  return best;
}
