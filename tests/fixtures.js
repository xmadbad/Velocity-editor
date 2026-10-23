// TfL Unified API yanıtlarının şeklini taklit eden küçük örnekler.
// (Kimlikler gerçeğe yakın ama testler için birebir doğru olmaları gerekmiyor.)

const WEST_READING = ['910GRDNGSTN', '910GMDNHEAD', '910GSLOUGH', '910GHAYESAH', '910GEALINGB'];
const WEST_HEATHROW_T5 = ['910GHTRWTM5', '910GHTRWAPT', '910GHAYESAH', '910GEALINGB'];
const CORE = ['910GPADTLL', '910GBONDST', '910GTOTCTRD', '910GFRNDXR', '910GLIVSTLL', '910GWCHAPXR'];
const EAST_ABBEY = ['910GCANWHRF', '910GCSTMHSXR', '910GWOLWXR', '910GABWDXR'];
const EAST_SHENFIELD = ['910GSTFD', '910GILFORD', '910GROMFORD', '910GSHENFLD'];

export const routeSequenceEast = {
  lineId: 'elizabeth',
  direction: 'outbound',
  orderedLineRoutes: [
    { name: 'Reading - Abbey Wood', naptanIds: [...WEST_READING, ...CORE, ...EAST_ABBEY], serviceType: 'Regular' },
    { name: 'Heathrow T5 - Shenfield', naptanIds: [...WEST_HEATHROW_T5, ...CORE, ...EAST_SHENFIELD], serviceType: 'Regular' },
    { name: 'Paddington - Abbey Wood', naptanIds: [...CORE, ...EAST_ABBEY], serviceType: 'Regular' },
  ],
};

// Yalnızca dallar (orderedLineRoutes boş) — branchPaths yolunu sınar.
export const routeSequenceBranchesOnly = {
  lineId: 'elizabeth',
  direction: 'outbound',
  orderedLineRoutes: [],
  stopPointSequences: [
    { branchId: 1, prevBranchIds: [], nextBranchIds: [2, 3], stopPoint: CORE.map((id) => ({ id })) },
    { branchId: 2, prevBranchIds: [1], nextBranchIds: [], stopPoint: EAST_ABBEY.map((id) => ({ id })) },
    { branchId: 3, prevBranchIds: [1], nextBranchIds: [], stopPoint: EAST_SHENFIELD.map((id) => ({ id })) },
  ],
};

export const stopPoints = [
  { naptanId: '910GBONDST', commonName: 'Bond Street' },
  { naptanId: '910GWOLWXR', commonName: 'Woolwich (Elizabeth line)' },
  { naptanId: '910GABWDXR', commonName: 'Abbey Wood (London) Rail Station' },
  { naptanId: '910GPADTLL', commonName: 'London Paddington' },
  { naptanId: '910GSHENFLD', commonName: 'Shenfield Rail Station' },
  { naptanId: '910GBONDST', commonName: 'Bond Street' },
];

const iso = (ms) => new Date(ms).toISOString();

export function arrivalsAtBondStreet(base) {
  const p = (min, destId, destName, extra = {}) => ({
    id: `p${min}${destId}`,
    lineId: 'elizabeth',
    naptanId: '910GBONDST',
    vehicleId: extra.vehicleId ?? '',
    platformName: extra.platformName ?? 'Eastbound - Platform B',
    destinationNaptanId: destId,
    destinationName: destName,
    expectedArrival: iso(base + min * 60_000),
    timeToStation: min * 60,
  });
  return [
    p(2, '910GABWDXR', 'Abbey Wood (London) Rail Station', { vehicleId: 'T1' }),
    p(4, '910GSHENFLD', 'Shenfield Rail Station'),
    p(5, '910GHTRWTM5', 'Heathrow Terminal 5 Rail Station', { platformName: 'Westbound - Platform A' }),
    p(7, '', 'Abbey Wood', { vehicleId: 'T2' }), // kimliksiz, isimden çözülmeli
    p(7, '', 'Abbey Wood'), // aynı tren, tekrar
    p(9, '910GCANWHRF', 'Canary Wharf'), // Woolwich'ten önce biter
    p(11, '910GXXXXXX', 'Mystery Town'),
    p(13, '910GABWDXR', 'Abbey Wood', { vehicleId: 'T3' }),
    { lineId: 'elizabeth', destinationName: 'Abbey Wood', expectedArrival: 'not-a-date' },
  ];
}
