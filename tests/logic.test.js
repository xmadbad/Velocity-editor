import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoutes, trainsForTrip, stationsFromStopPoints, nameIndex, cleanStationName,
  parseStatus, plan, insight, locSuffix, atTime, dayMode, Tracker, MIN, DEFAULTS,
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
