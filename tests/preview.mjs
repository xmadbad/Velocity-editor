// Arayüzün ekran görüntülerini sahte TfL verisiyle üretir (Tauri'siz, düz Chromium'da).
// Kullanım: node tests/preview.mjs <çıktı-klasörü>
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { routeSequenceEast, stopPoints } from './fixtures.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = resolve(process.argv[2] || 'shots');
const root = resolve(new URL('../src', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  try {
    const file = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const at = (h, m) => new Date(2026, 9, 23, h, m).getTime(); // Cuma
const SETTINGS = { fromId: '910GBONDST', fromName: 'Bond Street', toId: '910GWOLWXR', toName: 'Woolwich', walkMin: 8, leaveAt: '18:00', remindMin: 5, days: [1, 2, 3, 4, 5], notify: true, appKey: '' };

const status = (sev, desc, reason) => [{ id: 'elizabeth', lineStatuses: [{ statusSeverity: sev, statusSeverityDescription: desc, reason }] }];
const GOOD = status(10, 'Good Service');
const MINOR = status(9, 'Minor Delays', 'ELIZABETH LINE: Minor delays between Paddington and Abbey Wood due to an earlier faulty train at Whitechapel. Tickets are being accepted on London Underground.');

function arrivals(now, mins) {
  return mins.map(([m, dest, id, pl]) => ({
    lineId: 'elizabeth', naptanId: '910GBONDST', vehicleId: '', platformName: pl || 'Eastbound - Platform B',
    destinationNaptanId: id, destinationName: dest, expectedArrival: new Date(now + m * 60_000).toISOString(),
  }));
}
const EAST = (now, offsets) => arrivals(now, offsets.map((m) => [m, 'Abbey Wood', '910GABWDXR']).concat([[3, 'Shenfield', '910GSHENFLD'], [6, 'Heathrow Terminal 5', '910GHTRWTM5', 'Westbound - Platform A']]));

const scenes = [
  { name: '1-pill-relaxed', time: at(17, 42), arr: (n) => EAST(n, [9, 16, 25, 32, 39]), status: GOOD },
  { name: '2-panel', time: at(17, 42), arr: (n) => EAST(n, [9, 16, 25, 32, 39]), status: GOOD, open: 'main' },
  { name: '3-pill-now', time: at(17, 57), arr: (n) => EAST(n, [10, 17, 24]), status: GOOD },
  { name: '4-pill-run-minor', time: at(18, 6), arr: (n) => EAST(n, [8.5, 15, 22]), status: MINOR },
  { name: '5-panel-minor', time: at(17, 46), arr: (n) => EAST(n, [7, 14, 21, 28]), status: MINOR, open: 'main' },
  { name: '6-pill-idle-morning', time: at(9, 12), arr: (n) => EAST(n, [3, 9]), status: GOOD },
  { name: '7-settings', time: at(17, 42), arr: (n) => EAST(n, [9]), status: GOOD, open: 'settings' },
  { name: '8-first-run', time: at(12, 0), arr: () => [], status: GOOD, settings: null },
  { name: '9-dark-panel', time: at(17, 42), arr: (n) => EAST(n, [9, 16, 25, 32]), status: GOOD, open: 'main', dark: true },
  // İkinci ankette bütün trenler 4 dk kayar: Lizzie haber vermeli.
  { name: '10-alert', time: at(17, 44), arr: (n) => EAST(n, [12, 19, 26, 33]), arr2: (n) => EAST(n, [16, 23, 30, 37]), status: GOOD, alert: true },
];

const browser = await chromium.launch();
for (const sc of scenes) {
  const ctx = await browser.newContext({ timezoneId: 'Europe/London', locale: 'tr-TR', deviceScaleFactor: 2, viewport: { width: 320, height: 640 }, colorScheme: sc.dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(sc.name, 'pageerror', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(sc.name, m.text()));
  if (sc.alert) await page.clock.install({ time: sc.time });
  else await page.clock.setFixedTime(sc.time);
  let polls = 0;
  const s = sc.settings === null ? null : { ...SETTINGS, ...(sc.settings || {}) };
  await page.addInitScript((s) => {
    localStorage.clear();
    if (s) localStorage.setItem('lizzie:settings', JSON.stringify(s));
  }, s);
  await page.route('https://api.tfl.gov.uk/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/Status') ? sc.status
      : path.endsWith('/StopPoints') ? stopPoints.concat([{ naptanId: '910GLIVSTLL', commonName: 'Liverpool Street' }, { naptanId: '910GCANWHRF', commonName: 'Canary Wharf' }])
      : path.includes('/Route/Sequence/outbound') ? routeSequenceEast
      : path.includes('/Route/Sequence/') ? {}
      : path.includes('/Arrivals/') ? (polls++ && sc.arr2 ? sc.arr2(sc.time) : sc.arr(sc.time)) : [];
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.goto(base);
  await page.waitForTimeout(600);
  if (sc.open === 'main') await page.click('#headline');
  if (sc.open === 'settings') { await page.click('#headline'); await page.click('#btn-settings'); }
  if (sc.alert) await page.clock.fastForward(31_000);
  await page.waitForTimeout(900);
  await page.locator('#app').screenshot({ path: join(out, `${sc.name}.png`), omitBackground: true });
  console.log('ok', sc.name, await page.locator('#headline').textContent(), '|', await page.locator('#sub').textContent(), '|', await page.locator('#badge').textContent());
  await ctx.close();
}
await browser.close();
server.close();
