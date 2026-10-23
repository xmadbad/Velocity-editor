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
    if (!id || !name || byId.has(id)) continue;
    const st = { id, name };
    if (Number.isFinite(sp.lat) && Number.isFinite(sp.lon)) Object.assign(st, { lat: sp.lat, lon: sp.lon });
    byId.set(id, st);
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
  workId: '',
  workName: '',
  homeId: '',
  homeName: '',
  useLocation: true,
  bike: true, // Lime/Voi e-bisiklet karşılaştırması
  home: null, // { label, lat, lon }: ev kapısı
  work: null, // { label, lat, lon }: iş yeri
  walkMin: 8, // konum yokken masadan perona
  leaveAt: '18:00', // akşam işten çıkış
  morningAt: '', // sabah evden çıkış (isteğe bağlı)
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
  if (!parseHHMM(s.leaveAt)) return 'free'; // bu yön için saat yok: yalnızca istenince bak
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
  const L = parseHHMM(s.leaveAt) ? atToday(now, s.leaveAt) : now;
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

// ---------------------------------------------------------------- konum

// İki nokta arası kuş uçuşu mesafe (metre).
export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// Kuş uçuşu mesafeden yürüme: sokaklar ~%30 uzatır, 80 m/dk yürürsün,
// binadan çıkıp derindeki Elizabeth line peronuna inmek de ~4 dk sürer.
export function walkMinutes(meters) {
  return Math.round((meters * 1.3) / 80) + 4;
}

export const MAX_ACCURACY_M = 1500; // konum bundan bulanıksa güvenme
export const MAX_STATION_M = 5000; // en yakın durak bundan uzaksa "Londra'da değilsin"

const goesTo = (routes, fromId, toId) =>
  routes.some((r) => {
    const o = r.indexOf(fromId);
    return o >= 0 && r.indexOf(toId) > o;
  });

// Bugünkü yolculuk: nereden, nereye, kaç dk yürüme, hangi çıkış saati.
//   - Konum biliniyorsa en yakın durak kalkış durağıdır. O durak evinse sabah
//     yönüne (eve → işe) geçer, değilse oradan eve gidersin.
//   - Konum yoksa ya da bulanıksa ayarlardaki duraklar kullanılır: sabah saati
//     verilmişse öğleden önce işe, sonra eve.
// pos: { lat, lon, accuracy } | null. prevFromId: az önce seçilen kalkış durağı; konum
// birkaç metre oynadı diye iki durak arasında gidip gelmeyelim diye ona biraz yapışırız.
// Dönen yolculukta toPlace/fromPlace, ev ve iş yerinin kendisidir (kapıdan kapıya tarif için).
export function chooseTrip({ pos, stations = [], routes = [], settings: s, now, prevFromId = '' }) {
  const home = { id: s.homeId, name: s.homeName };
  const work = { id: s.workId, name: s.workName };
  const toWork = (from, walkMin, extra) => ({ dir: 'work', from, to: work.id ? work : null, toPlace: s.work || null, walkMin, leaveAt: s.morningAt, ...extra });
  const toHome = (from, walkMin, extra) => ({ dir: 'home', from, to: home, toPlace: s.home || null, walkMin, leaveAt: s.leaveAt, ...extra });

  if (pos && pos.accuracy <= MAX_ACCURACY_M) {
    const near = stations
      .filter((st) => Number.isFinite(st.lat))
      .map((st) => ({ ...st, d: distanceM(pos, st) }))
      .sort((a, b) => a.d - b.d);
    const nearest = near[0];
    if (nearest && nearest.d <= MAX_STATION_M) {
      const extra = { source: 'location', distM: nearest.d };
      const atHome = (s.home && distanceM(pos, s.home) <= AT_PLACE_M) || nearest.id === home.id;
      if (atHome) {
        const homeSt = near.find((st) => st.id === home.id) || nearest;
        return toWork(home, walkMinutes(homeSt.d), { ...extra, distM: homeSt.d });
      }
      // Biraz daha uzak ama eve aktarmasız giden bir durak, aktarmalı en yakından iyidir.
      const usable = (st) => !routes.length || goesTo(routes, st.id, home.id);
      const best = near.find((st) => st.d <= nearest.d + 800 && usable(st)) || nearest;
      const prev = near.find((st) => st.id === prevFromId && st.id !== home.id);
      const from = prev && prev.d <= best.d + 200 && usable(prev) ? prev : best;
      return toHome({ id: from.id, name: from.name }, walkMinutes(from.d), { ...extra, distM: from.d });
    }
  }

  // Konumsuz: ev/iş yeri biliniyorsa yürüme oradan durağa, yoksa ayardaki süre.
  const walkFrom = (place, stId) => {
    const st = stations.find((x) => x.id === stId);
    return place && st && Number.isFinite(st.lat) ? walkMinutes(distanceM(place, st)) : Number(s.walkMin) || 0;
  };
  const morning = parseHHMM(s.morningAt) && new Date(now).getHours() < 12;
  return morning && work.id
    ? toWork(home, walkFrom(s.home, home.id), { source: 'manual', fromPlace: s.home || null })
    : toHome(work, walkFrom(s.work, work.id), { source: 'manual', fromPlace: s.work || null });
}

export const AT_PLACE_M = 400; // eve bu kadar yakınsan "evdesin"

// Bir yere (ev/iş) en yakın Elizabeth line durağı; towardsId verilirse oraya aktarmasız
// giden ve en yakından en fazla 800 m uzak bir durak tercih edilir.
export function nearestStation(place, stations, { routes = [], towardsId = '' } = {}) {
  const near = stations
    .filter((st) => Number.isFinite(st.lat))
    .map((st) => ({ ...st, d: distanceM(place, st) }))
    .sort((a, b) => a.d - b.d);
  if (!near.length) return null;
  const direct = (st) => !towardsId || !routes.length || goesTo(routes, st.id, towardsId) || goesTo(routes, towardsId, st.id);
  return near.find((st) => st.d <= near[0].d + 800 && direct(st)) || near[0];
}

// TfL Journey Planner'ı adres defteri gibi kullanırız: belirsiz bir yer için 300 +
// seçenek listesi, tanınan bir yer (ör. posta kodu) için doğrudan yolculuk döner.
export function placeOptions(resp) {
  const out = [];
  const add = (name, lat, lon, quality = 0) => {
    const label = String(name || '').trim();
    if (label && Number.isFinite(lat) && Number.isFinite(lon) && !out.some((o) => o.label === label)) {
      out.push({ label, lat, lon, quality });
    }
  };
  for (const o of resp?.fromLocationDisambiguation?.disambiguationOptions || []) {
    add(o.place?.commonName, o.place?.lat, o.place?.lon, o.matchQuality || 0);
  }
  if (!out.length) {
    const p = resp?.journeys?.[0]?.legs?.[0]?.departurePoint;
    if (p) add(p.commonName, p.lat, p.lon);
  }
  return out.sort((a, b) => b.quality - a.quality).slice(0, 6).map(({ label, lat, lon }) => ({ label, lat, lon }));
}

// ---------------------------------------------------------------- e-bisiklet (Lime / Voi)

// Bisikleti bulmak, kilidini açmak ve park yerine bırakmak için pay (dk).
export const BIKE_OVERHEAD_MIN = 4;

// TfL Journey Planner yanıtından en kısa yolculuk. needMode verilirse o modu
// içermeyen (ör. baştan sona yürüyüş) yolculuklar sayılmaz.
export function bestJourney(resp, needMode = '') {
  let best = null;
  for (const j of resp?.journeys || []) {
    const modes = (j.legs || []).map((l) => l.mode?.id);
    if (needMode && !modes.includes(needMode)) continue;
    if (!Number.isFinite(j.duration)) continue;
    if (!best || j.duration < best.duration) {
      best = { duration: j.duration, arrival: Date.parse(j.arrivalDateTime) || 0, leaveAt: Date.parse(j.startDateTime), steps: journeySteps(j) };
    }
  }
  return best;
}

// ---------------------------------------------------------------- yol tarifi

const RIDE_ICON = { 'elizabeth-line': '🟣', tube: '🚇', dlr: '🚈', overground: '🟠', 'national-rail': '🚆', bus: '🚌', tram: '🚊', 'river-bus': '⛴️', 'cable-car': '🚡', cycle: '🚲' };

// Bir TfL yolculuğunu "yürü / bin / in / aktar" adımlarına çevirir.
export function journeySteps(j) {
  const steps = [];
  for (const leg of j?.legs || []) {
    const mode = leg.mode?.id || '';
    const minutes = Math.round(leg.duration || 0);
    if (mode === 'walking') {
      const last = steps[steps.length - 1];
      const to = cleanStationName(leg.arrivalPoint?.commonName || '');
      if (last?.kind === 'walk') Object.assign(last, { minutes: last.minutes + minutes, to });
      else steps.push({ kind: 'walk', minutes, to });
      continue;
    }
    const dir = ((leg.routeOptions || [])[0]?.directions || [])[0] || '';
    steps.push({
      kind: 'ride',
      mode,
      icon: RIDE_ICON[mode] || '🚉',
      line: legName(leg),
      direction: dir ? cleanStationName(dir) : '',
      from: cleanStationName(leg.departurePoint?.commonName || ''),
      to: cleanStationName(leg.arrivalPoint?.commonName || ''),
      dep: Date.parse(leg.departureTime),
      arr: Date.parse(leg.arrivalTime),
      stops: (leg.path?.stopPoints || []).length,
      minutes,
      transfer: steps.some((s) => s.kind === 'ride'),
      disrupted: Boolean(leg.isDisrupted),
    });
  }
  return steps.filter((st) => st.kind !== 'walk' || st.minutes >= 1);
}

// Trenle mi e-bisikletle mi? Kapıdan kapıya dakikalar (bisiklete bulma/park payı dahil).
// suggest: bisiklet belirgin hızlıysa ya da hat sorunluyken makul bir alternatifse.
export function bikeVerdict(bikeMin, trainMin, level = 'good') {
  if (!Number.isFinite(bikeMin)) return null;
  if (!Number.isFinite(trainMin)) return { bikeMin, trainMin: null, faster: 'bike', diff: 0, suggest: level !== 'good' };
  const diff = Math.round(trainMin - bikeMin);
  const faster = Math.abs(diff) < 2 ? 'same' : diff > 0 ? 'bike' : 'train';
  const troubled = level === 'bad' || level === 'closed';
  return { bikeMin, trainMin, faster, diff: Math.abs(diff), suggest: diff >= 5 || (troubled && bikeMin <= trainMin + 15) };
}

// GBFS free_bike_status: yakındaki kullanılabilir araçlar.
export function nearbyVehicles(feed, pos, radiusM = 400) {
  const bikes = feed?.data?.bikes || feed?.data?.vehicles || [];
  let count = 0;
  let nearest = null;
  for (const b of bikes) {
    if (b.is_reserved || b.is_disabled || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
    const d = distanceM(pos, b);
    if (d > radiusM) continue;
    count++;
    if (!nearest || d < nearest.d) nearest = { d, rangeM: b.current_range_meters };
  }
  return { count, nearestM: nearest ? Math.round(nearest.d) : null, rangeM: nearest?.rangeM ?? null };
}

// ---------------------------------------------------------------- B planı (başka hat)

const MODE_NAME = { 'national-rail': 'Tren', overground: 'Overground', bus: 'Otobüs', tube: 'Tube', dlr: 'DLR', tram: 'Tram' };

function legName(leg) {
  const mode = leg.mode?.id || '';
  const route = (leg.routeOptions || []).map((r) => r.name).find(Boolean) || '';
  if (mode === 'bus') return route ? `Otobüs ${route}` : 'Otobüs';
  if (route) return route;
  const summary = String(leg.instruction?.summary || '').split(/\s+(?:to|towards)\s+/i)[0].trim();
  return summary || MODE_NAME[mode] || mode;
}

// Elizabeth line'sız en erken varan yolculuk: { lines: ['Jubilee', 'DLR'], leaveAt, arrive, duration }
export function bestAlternative(resp) {
  let best = null;
  for (const j of resp?.journeys || []) {
    const rides = (j.legs || []).filter((l) => l.mode?.id && l.mode.id !== 'walking');
    if (!rides.length || rides.some((l) => l.mode.id === 'elizabeth-line')) continue;
    const arrive = Date.parse(j.arrivalDateTime);
    if (!Number.isFinite(arrive) || (best && arrive >= best.arrive)) continue;
    const lines = [];
    for (const leg of rides) {
      const name = legName(leg);
      if (lines[lines.length - 1] !== name) lines.push(name);
    }
    best = { lines, leaveAt: Date.parse(j.startDateTime), arrive, duration: j.duration, steps: journeySteps(j) };
  }
  return best;
}

// B planını öne çıkaralım mı? Hat kapalıysa, eve giden tren hiç görünmüyorsa ya da
// ciddi aksaklıkta başka hat belirgin erken vardırıyorsa.
export function planBNeeded({ alt, level, hasTrains, early, trainArrive }) {
  if (!alt) return false;
  if (level === 'closed') return true;
  if (!hasTrains && !early) return true;
  if (level === 'bad') return !Number.isFinite(trainArrive) || alt.arrive <= trainArrive - 2 * MIN;
  return false;
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
