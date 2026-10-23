import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoutes, trainsForTrip, stationsFromStopPoints, nameIndex, cleanStationName,
  parseStatus, plan, insight, locSuffix, atTime, dayMode, Tracker, MIN, DEFAULTS,
  chooseTrip, distanceM, walkMinutes, bestJourney, bikeVerdict, nearbyVehicles,
  bestAlternative, planBNeeded, journeySteps, placeOptions, nearestStation,
} from '../src/logic.js';
import { routeSequenceEast, routeSequenceBranchesOnly, stopPoints, arrivalsAtBondStreet } from './fixtures.js';

const at = (h, m, s = 0) => new Date(2026, 9, 23, h, m, s).getTime(); // Cuma 23 Ekim 2026
const settings = { ...DEFAULTS, walkMin: 8, leaveAt: '18:00' };
const train = (h, m, dest = 'Abbey Wood', vehicleId = '') => ({
  key: `${vehicleId}|${dest}|${h}:${m}`, vehicleId, time: at(h, m), dest, destId: 'X', platform: '',
});

test('istasyon adları sadeleşir', () => {
  assert.equal(cleanStationName('Abbey Wood (London) Rail Station'), 'Abbey Wood');
  assert.equal(cleanStationName('London Paddington'), 'Paddington');
  assert.equal(cleanStationName('Woolwich (Elizabeth line)'), 'Woolwich');
  assert.equal(cleanStationName('Heathrow Terminals 2 & 3 Rail Station'), 'Heathrow Terminals 2 & 3');
  const st = stationsFromStopPoints(stopPoints);
  assert.equal(st.length, 5);
  assert.deepEqual(st[0], { id: '910GABWDXR', name: 'Abbey Wood' });
});

test('Bond Street → Woolwich: yalnızca Abbey Wood trenleri', () => {
  const base = at(17, 50);
  const routes = buildRoutes([routeSequenceEast]);
  const nameToId = nameIndex(stationsFromStopPoints(stopPoints));
  const r = trainsForTrip(arrivalsAtBondStreet(base), { fromId: '910GBONDST', toId: '910GWOLWXR', routes, nameToId });
  assert.deepEqual(r.trains.map((t) => (t.time - base) / MIN), [2, 7, 13]);
  assert.ok(r.trains.every((t) => t.dest === 'Abbey Wood'));
  assert.equal(r.trains[0].platform, 'B');
  assert.deepEqual(r.unknown.map((t) => t.dest), ['Mystery Town']);
});

test('ters yön ve dal yapısı', () => {
  const base = at(17, 50);
  const routes = buildRoutes([routeSequenceEast]);
  // Woolwich → Bond Street yönünde Abbey Wood'a giden tren işe yaramaz
  const back = trainsForTrip(arrivalsAtBondStreet(base), { fromId: '910GWOLWXR', toId: '910GBONDST', routes });
  assert.equal(back.trains.length, 0);
  // Sadece stopPointSequences olsa da rota kurulabilmeli
  const branchRoutes = buildRoutes([routeSequenceBranchesOnly]);
  const r = trainsForTrip(arrivalsAtBondStreet(base), { fromId: '910GBONDST', toId: '910GILFORD', routes: branchRoutes });
  assert.deepEqual(r.trains.map((t) => t.dest), ['Shenfield']);
});

test('hat durumu seviyeleri', () => {
  assert.equal(parseStatus([{ id: 'elizabeth', lineStatuses: [{ statusSeverity: 10, statusSeverityDescription: 'Good Service' }] }]).level, 'good');
  const minor = parseStatus([{ id: 'elizabeth', lineStatuses: [{ statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'ELIZABETH LINE:  Minor delays due to a faulty train.' }] }]);
  assert.equal(minor.level, 'minor');
  assert.equal(minor.reason, 'Minor delays due to a faulty train.');
  const mixed = parseStatus([{ id: 'elizabeth', lineStatuses: [
    { statusSeverity: 9, statusSeverityDescription: 'Minor Delays', reason: 'a' },
    { statusSeverity: 5, statusSeverityDescription: 'Part Closure', reason: 'b' },
  ] }]);
  assert.equal(mixed.level, 'bad');
  assert.equal(mixed.desc, 'Minor Delays + Part Closure');
  assert.equal(mixed.reason, 'b');
  assert.equal(parseStatus([]).level, 'unknown');
});

test('Türkçe saat ekleri', () => {
  const cases = { '17:59': 'da', '18:00': 'de', '18:04': 'te', '18:10': 'da', '18:20': 'de', '18:30': 'da',
    '18:40': 'ta', '18:50': 'de', '18:06': 'da', '18:01': 'de', '17:00': 'de', '16:00': 'da', '15:00': 'te',
    '13:00': 'te', '19:00': 'da', '20:00': 'de', '0:00': 'da', '10:00': 'da' };
  for (const [hhmm, suffix] of Object.entries(cases)) {
    const [h, m] = hhmm.split(':').map(Number);
    assert.equal(locSuffix(h, m), suffix, hhmm);
  }
  assert.equal(atTime(at(17, 59)), "17:59'da");
});

test('plan: 18:00 civarı en mantıklı çıkış', () => {
  const trains = [train(18, 2), train(18, 7), train(18, 14), train(18, 21)];
  const p = plan(trains, at(17, 30), settings);
  assert.equal(p.target.time, at(18, 7)); // 17:59'da çık
  assert.equal(p.target.leaveBy, at(17, 59));
  assert.equal(p.alt.time, at(18, 14));
  assert.equal(p.atL.train.time, at(18, 14)); // 18:00'de çıksan 18:07'yi kaçırırsın
  assert.equal(insight(p), "18:00 yerine 17:59'da çıkarsan 18:07 trenine binersin, eve 7 dk erken varırsın.");

  const later = plan([train(18, 12), train(18, 20)], at(17, 30), settings);
  assert.equal(later.target.time, at(18, 12));
  assert.equal(insight(later), "18:00'de çıkarsan perona 18:08 gibi varıp 4 dk beklersin. 18:04'te çık, beklemeden bin.");
});

test('plan: çıkış saati geçince ilk yetişilebilir tren', () => {
  const trains = [train(18, 10), train(18, 13), train(18, 20)];
  const p = plan(trains, at(18, 4, 30), settings);
  // 18:10 için 18:02'de çıkmalıydın: kaçtı. 18:13 için 18:05 → koş (0.5 dk)
  assert.equal(p.list[0].time, at(18, 13));
  assert.equal(p.target.state, 'run');
  assert.equal(p.alt.time, at(18, 20));
  assert.equal(p.atL, null);
  assert.equal(insight(p), '');
});

test('günün modu', () => {
  assert.equal(dayMode(at(17, 30), settings), 'live');
  assert.equal(dayMode(at(9, 0), settings), 'before');
  assert.equal(dayMode(at(22, 0), settings), 'after');
  assert.equal(dayMode(new Date(2026, 9, 24, 18, 0).getTime(), settings), 'off'); // Cumartesi
});

test('takipçi: rötar ve iptal haber verilir, normal akış sessizdir', () => {
  const tr = new Tracker();
  const poll = (trains, now) => tr.update(plan(trains, now, settings), now);

  assert.deepEqual(poll([train(18, 7, 'Abbey Wood', 'V1'), train(18, 14)], at(17, 40)), []);
  assert.deepEqual(poll([train(18, 8, 'Abbey Wood', 'V1'), train(18, 14)], at(17, 40, 30)), []); // 1 dk: sessiz
  const ev = poll([train(18, 10, 'Abbey Wood', 'V1'), train(18, 14)], at(17, 41));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'shift');
  assert.equal(ev[0].delta, 3); // 18:07 → 18:10, birikerek

  // Tren listeden düşer: bir anket tolerans, ikincisinde haber
  assert.deepEqual(poll([train(18, 21)], at(17, 41, 30)), []);
  const gone = poll([train(18, 21)], at(17, 42));
  assert.equal(gone[0].type, 'gone');
  assert.equal(gone[0].next.time, at(18, 21));

  // Tren gelip geçince sessizce bir sonrakine geçer
  assert.deepEqual(poll([train(18, 21)], at(18, 20, 30)), []);
});

test('takipçi: araç kimliği yokken bütün trenler kayarsa doğru treni izler', () => {
  const tr = new Tracker();
  const poll = (trains, now) => tr.update(plan(trains, now, settings), now);
  poll([train(17, 56), train(18, 3), train(18, 10), train(18, 17)], at(17, 44)); // hedef 18:10
  const ev = poll([train(18, 0), train(18, 7), train(18, 14), train(18, 21)], at(17, 44, 30));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].delta, 4); // 18:10 → 18:14, "3 dk erken" değil
  assert.equal(ev[0].from.base, at(18, 10));
});

// ------------------------------------------------------------------ konum

const STATIONS = [
  { id: '910GBONDST', name: 'Bond Street', lat: 51.5142, lon: -0.1494 },
  { id: '910GTOTCTRD', name: 'Tottenham Court Road', lat: 51.5165, lon: -0.1310 },
  { id: '910GWOLWXR', name: 'Woolwich', lat: 51.4917, lon: 0.0714 },
  { id: '910GSTFD', name: 'Stratford', lat: 51.5416, lon: -0.0033 },
  { id: '910GCANWHRF', name: 'Canary Wharf', lat: 51.5059, lon: -0.0187 },
];
const ME = { ...DEFAULTS, workId: '910GBONDST', workName: 'Bond Street', homeId: '910GWOLWXR', homeName: 'Woolwich', walkMin: 8, leaveAt: '18:00', morningAt: '08:30' };
const routesEast = buildRoutes([routeSequenceEast]);
const trip = (pos, now = at(17, 30), settings = ME) => chooseTrip({ pos, stations: STATIONS, routes: routesEast, settings, now });

test('mesafe ve yürüme', () => {
  const d = distanceM({ lat: 51.5142, lon: -0.1494 }, { lat: 51.5165, lon: -0.1310 });
  assert.ok(d > 1250 && d < 1350, String(d)); // Bond St ↔ TCR ~1.3 km
  assert.equal(walkMinutes(0), 4);
  assert.equal(walkMinutes(400), 11);
});

test('konum: ofisteyken en yakın duraktan eve', () => {
  const t = trip({ lat: 51.5152, lon: -0.1470, accuracy: 40 }); // Bond Street'e ~200 m
  assert.equal(t.dir, 'home');
  assert.equal(t.from.id, '910GBONDST');
  assert.equal(t.to.id, '910GWOLWXR');
  assert.equal(t.source, 'location');
  assert.equal(t.leaveAt, '18:00');
  assert.equal(t.walkMin, walkMinutes(t.distM));

  const tcr = trip({ lat: 51.5163, lon: -0.1325, accuracy: 40 }); // bugün TCR yakınındasın
  assert.equal(tcr.from.id, '910GTOTCTRD');
});

test('konum: evdeyken yön işe döner', () => {
  const t = trip({ lat: 51.4925, lon: 0.0690, accuracy: 60 }, at(8, 0));
  assert.equal(t.dir, 'work');
  assert.equal(t.from.id, '910GWOLWXR');
  assert.equal(t.to.id, '910GBONDST');
  assert.equal(t.leaveAt, '08:30');
});

test('konum: aktarmasız giden biraz uzak durak tercih edilir', () => {
  // Stratford'a 300 m (Shenfield dalı, Woolwich'e gitmez), Canary Wharf'a ~700 m
  const stations = [
    { id: '910GSTFD', name: 'Stratford', lat: 51.6, lon: 0.0027 },
    { id: '910GCANWHRF', name: 'Canary Wharf', lat: 51.6, lon: -0.0100 },
  ];
  const pos = { lat: 51.6, lon: -0.0016, accuracy: 30 };
  const t = chooseTrip({ pos, stations, routes: routesEast, settings: ME, now: at(17, 30) });
  assert.equal(t.from.id, '910GCANWHRF');
});

test('konum yok ya da bulanık: ayarlardaki duraklar', () => {
  const vague = trip({ lat: 51.5152, lon: -0.1470, accuracy: 3000 });
  assert.equal(vague.source, 'manual');
  assert.equal(vague.from.id, '910GBONDST');
  assert.equal(vague.walkMin, 8);
  assert.equal(trip(null, at(8, 0)).dir, 'work'); // sabah saati var, öğleden önce
  assert.equal(trip(null, at(8, 0), { ...ME, morningAt: '' }).dir, 'home');
  assert.equal(trip({ lat: 40.7, lon: -74, accuracy: 20 }).source, 'manual'); // New York
});

test('sabah saati yoksa plan "şimdi"ye göre yapılır', () => {
  assert.equal(dayMode(at(8, 0), { ...ME, leaveAt: '' }), 'free');
  const p = plan([train(8, 10), train(8, 17)], at(8, 0), { walkMin: 8, leaveAt: '' });
  assert.equal(p.target.time, at(8, 10));
  assert.equal(p.early, false);
});

test('konum: iki durak arasında küçük oynamalarda durak değişmez', () => {
  // Bond Street (−0.1494) ile TCR (−0.1310) arasının tam ortası, biraz TCR tarafı
  const mid = { lat: 51.5153, lon: -0.1398, accuracy: 30 };
  const first = trip(mid);
  assert.equal(first.from.id, '910GTOTCTRD');
  const wobble = { ...mid, lon: -0.1408 }; // ~70 m Bond Street'e kaydı
  const fresh = chooseTrip({ pos: wobble, stations: STATIONS, routes: routesEast, settings: ME, now: at(17, 30) });
  assert.equal(fresh.from.id, '910GBONDST'); // hafızasız olsa değişirdi
  const sticky = chooseTrip({ pos: wobble, stations: STATIONS, routes: routesEast, settings: ME, now: at(17, 30), prevFromId: first.from.id });
  assert.equal(sticky.from.id, '910GTOTCTRD');
  const moved = chooseTrip({ pos: { lat: 51.5145, lon: -0.1480, accuracy: 30 }, stations: STATIONS, routes: routesEast, settings: ME, now: at(17, 30), prevFromId: first.from.id });
  assert.equal(moved.from.id, '910GBONDST'); // gerçekten yürüdün
});

// ------------------------------------------------------------------ e-bisiklet

test('Journey Planner: en kısa yolculuk, gereken mod yoksa sayılmaz', () => {
  const resp = { journeys: [
    { duration: 44, arrivalDateTime: '2026-10-23T18:44:00', legs: [{ mode: { id: 'walking' } }, { mode: { id: 'elizabeth-line' } }, { mode: { id: 'walking' } }] },
    { duration: 39, arrivalDateTime: '2026-10-23T18:39:00', legs: [{ mode: { id: 'walking' } }, { mode: { id: 'elizabeth-line' } }] },
    { duration: 30, arrivalDateTime: '2026-10-23T18:30:00', legs: [{ mode: { id: 'walking' } }] }, // trensiz
  ] };
  assert.equal(bestJourney(resp, 'elizabeth-line').duration, 39);
  assert.equal(bestJourney(resp).duration, 30);
  assert.equal(bestJourney({}), null);
});

test('bisiklet mi tren mi', () => {
  assert.deepEqual(bikeVerdict(32, 41), { bikeMin: 32, trainMin: 41, faster: 'bike', diff: 9, suggest: true });
  assert.equal(bikeVerdict(45, 39).faster, 'train');
  assert.equal(bikeVerdict(45, 39).suggest, false);
  assert.equal(bikeVerdict(45, 39, 'closed').suggest, true); // hat kapalıyken öner
  assert.equal(bikeVerdict(60, 39, 'bad').suggest, false); // ama çok uzunsa değil
  assert.equal(bikeVerdict(40, 41).faster, 'same');
  assert.equal(bikeVerdict(NaN, 41), null);
});

test('GBFS: yakındaki kullanılabilir bisikletler', () => {
  const pos = { lat: 51.5152, lon: -0.1470 };
  const feed = { data: { bikes: [
    { lat: 51.5155, lon: -0.1470, current_range_meters: 21000 }, // ~33 m
    { lat: 51.5160, lon: -0.1470, is_reserved: true }, // rezerve
    { lat: 51.5170, lon: -0.1470 }, // ~200 m
    { lat: 51.5300, lon: -0.1470 }, // 1.6 km
  ] } };
  const r = nearbyVehicles(feed, pos);
  assert.equal(r.count, 2);
  assert.ok(r.nearestM >= 30 && r.nearestM <= 36, String(r.nearestM));
  assert.equal(r.rangeM, 21000);
});

// ------------------------------------------------------------------ B planı

const leg = (id, name, summary) => ({ mode: { id }, routeOptions: name ? [{ name }] : [], instruction: { summary: summary || '' } });

test('B planı: Elizabeth line olmadan en erken varan', () => {
  const resp = { journeys: [
    { startDateTime: '2026-10-23T17:55:00', arrivalDateTime: '2026-10-23T18:41:00', duration: 46,
      legs: [leg('walking'), leg('tube', 'Jubilee'), leg('dlr', 'DLR'), leg('dlr', 'DLR'), leg('walking')] },
    { startDateTime: '2026-10-23T17:52:00', arrivalDateTime: '2026-10-23T18:36:00', duration: 44,
      legs: [leg('walking'), leg('tube', 'Jubilee'), leg('national-rail', '', 'Southeastern to Woolwich Arsenal'), leg('walking')] },
    { startDateTime: '2026-10-23T17:50:00', arrivalDateTime: '2026-10-23T18:20:00', duration: 30,
      legs: [leg('walking'), leg('elizabeth-line', 'Elizabeth line')] }, // Elizabeth: sayılmaz
    { startDateTime: '2026-10-23T17:50:00', arrivalDateTime: '2026-10-23T19:30:00', duration: 100,
      legs: [leg('bus', '53'), leg('walking')] },
    { startDateTime: '2026-10-23T17:50:00', arrivalDateTime: '2026-10-23T18:10:00', duration: 20, legs: [leg('walking')] }, // yalnız yürüyüş
  ] };
  const alt = bestAlternative(resp);
  assert.deepEqual(alt.lines, ['Jubilee', 'Southeastern']);
  assert.equal(alt.leaveAt, new Date(2026, 9, 23, 17, 52).getTime());
  assert.equal(alt.duration, 44);
  assert.deepEqual(bestAlternative({ journeys: [resp.journeys[3]] }).lines, ['Otobüs 53']);
  assert.equal(bestAlternative({}), null);
});

test('B planı ne zaman öne çıkar', () => {
  const alt = { arrive: at(18, 36) };
  assert.equal(planBNeeded({ alt: null, level: 'closed' }), false);
  assert.equal(planBNeeded({ alt, level: 'closed', hasTrains: true }), true);
  assert.equal(planBNeeded({ alt, level: 'good', hasTrains: false, early: false }), true); // tren yok
  assert.equal(planBNeeded({ alt, level: 'good', hasTrains: false, early: true }), false); // henüz erken
  assert.equal(planBNeeded({ alt, level: 'bad', hasTrains: true, trainArrive: at(18, 50) }), true);
  assert.equal(planBNeeded({ alt, level: 'bad', hasTrains: true, trainArrive: at(18, 37) }), false);
  assert.equal(planBNeeded({ alt, level: 'minor', hasTrains: true, trainArrive: at(19, 0) }), false);
});

// ------------------------------------------------------------------ ev / iş ve yol tarifi

test('yol tarifi: yürü, bin, in, aktar', () => {
  const j = {
    startDateTime: '2026-10-23T17:55:00', arrivalDateTime: '2026-10-23T18:36:00', duration: 41,
    legs: [
      { mode: { id: 'walking' }, duration: 3, arrivalPoint: { commonName: 'Bond Street Underground Station' } },
      { mode: { id: 'walking' }, duration: 0.4, arrivalPoint: { commonName: 'Bond Street Underground Station' } },
      { mode: { id: 'tube' }, duration: 16, routeOptions: [{ name: 'Jubilee', directions: ['Stratford Underground Station'] }],
        departurePoint: { commonName: 'Bond Street Underground Station' }, arrivalPoint: { commonName: 'Canning Town Underground Station' },
        departureTime: '2026-10-23T17:59:00', arrivalTime: '2026-10-23T18:15:00', path: { stopPoints: [1, 2, 3, 4, 5, 6, 7, 8] } },
      { mode: { id: 'walking' }, duration: 2, arrivalPoint: { commonName: 'Canning Town DLR Station' } },
      { mode: { id: 'dlr' }, duration: 12, routeOptions: [{ name: 'DLR', directions: ['Woolwich Arsenal DLR Station'] }],
        departurePoint: { commonName: 'Canning Town DLR Station' }, arrivalPoint: { commonName: 'Woolwich Arsenal DLR Station' },
        departureTime: '2026-10-23T18:19:00', arrivalTime: '2026-10-23T18:31:00', path: { stopPoints: [1, 2, 3, 4, 5] } },
      { mode: { id: 'walking' }, duration: 5, arrivalPoint: { commonName: 'SE18 6HQ' } },
    ],
  };
  const st = journeySteps(j);
  assert.deepEqual(st.map((x) => x.kind), ['walk', 'ride', 'walk', 'ride', 'walk']);
  assert.equal(st[0].minutes, 3); // 0.4 dk'lık yürüyüş birleşti
  assert.equal(st[0].to, 'Bond Street');
  assert.deepEqual([st[1].line, st[1].direction, st[1].from, st[1].to, st[1].stops, st[1].transfer], ['Jubilee', 'Stratford', 'Bond Street', 'Canning Town', 8, false]);
  assert.equal(st[1].dep, new Date(2026, 9, 23, 17, 59).getTime());
  assert.equal(st[3].transfer, true);
  assert.equal(st[3].icon, '🚈');
  assert.equal(bestAlternative({ journeys: [j] }).steps.length, 5);
});

test('yer arama: TfL seçenek listesi ya da tanınan posta kodu', () => {
  const list = placeOptions({ fromLocationDisambiguation: { matchStatus: 'list', disambiguationOptions: [
    { matchQuality: 700, place: { commonName: 'Oxford Street, London', lat: 51.515, lon: -0.142 } },
    { matchQuality: 990, place: { commonName: 'Bond Street Underground Station', lat: 51.514, lon: -0.149 } },
    { matchQuality: 500, place: { commonName: 'Nowhere' } }, // koordinatsız
  ] } });
  assert.deepEqual(list.map((o) => o.label), ['Bond Street Underground Station', 'Oxford Street, London']);
  const direct = placeOptions({ journeys: [{ legs: [{ departurePoint: { commonName: 'SE18 6HQ', lat: 51.49, lon: 0.07 } }] }] });
  assert.deepEqual(direct, [{ label: 'SE18 6HQ', lat: 51.49, lon: 0.07 }]);
  assert.deepEqual(placeOptions({}), []);
});

test('ev/iş yerine en yakın durak', () => {
  assert.equal(nearestStation({ lat: 51.4925, lon: 0.0690 }, STATIONS).id, '910GWOLWXR');
  assert.equal(nearestStation({ lat: 51.5152, lon: -0.1470 }, STATIONS, { routes: routesEast, towardsId: '910GWOLWXR' }).id, '910GBONDST');
  assert.equal(nearestStation({ lat: 1, lon: 1 }, []), null);
});

test('konum: ev adresine yakınsan evdesin, tarif kapıya kadar', () => {
  const s = { ...ME, home: { label: 'Ev', lat: 51.4990, lon: 0.0600 }, work: { label: 'Ofis', lat: 51.5152, lon: -0.1470 } };
  // Ev, Woolwich durağına ~1 km; en yakın durak başka olsa bile 400 m içindeysen evdesin
  const t = chooseTrip({ pos: { lat: 51.4992, lon: 0.0605, accuracy: 30 }, stations: STATIONS, routes: routesEast, settings: s, now: at(8, 0) });
  assert.equal(t.dir, 'work');
  assert.equal(t.from.id, '910GWOLWXR');
  assert.deepEqual(t.toPlace, s.work);
  // Konumsuz akşam: işten eve, yürüme iş yerinden durağa
  const m = chooseTrip({ pos: null, stations: STATIONS, routes: routesEast, settings: s, now: at(17, 30) });
  assert.equal(m.dir, 'home');
  assert.deepEqual(m.fromPlace, s.work);
  assert.deepEqual(m.toPlace, s.home);
  assert.ok(m.walkMin >= 4 && m.walkMin <= 8, String(m.walkMin));
});
