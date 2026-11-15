// node tests/e2e.js [스크린샷 경로]
// Bybit 응답을 문서 형식 그대로 흉내 낸 "모의 데이터"로 브라우저에서 앱 전체를 돌려 본다.
// (실제 시세가 아님 — 렌더링/배선 검증용)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const SEC = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, D: 86400, W: 604800 };
const OI_SEC = { '5min': 300, '15min': 900, '30min': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const NOW = Math.floor(Date.now() / 1000);
// 시각만으로 결정되는 가격 경로 → 모든 타임프레임이 서로 일관됨
const noise = (x) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
const priceAt = (t) => 95000 + 6000 * Math.sin(t / 90000) + 2500 * Math.sin(t / 17000) + 900 * Math.sin(t / 3100) + 300 * Math.sin(t / 700) + 120 * (noise(Math.floor(t / 300)) - 0.5);
const oiAt = (t) => 52000 + 4000 * Math.sin(t / 40000) + 1500 * Math.sin(t / 5000) + 300 * noise(Math.floor(t / 300) + 7);
function kline(t, sec) {
  let o = priceAt(t), c = priceAt(Math.min(t + sec, NOW)), h = Math.max(o, c), l = Math.min(o, c);
  for (let k = 1; k < 8; k++) { const p = priceAt(Math.min(t + (sec * k) / 8, NOW)); h = Math.max(h, p); l = Math.min(l, p); }
  return [String(t * 1000), o.toFixed(1), (h + 15).toFixed(1), (l - 15).toFixed(1), c.toFixed(1), (50 + 400 * noise(t)).toFixed(3), '0'];
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.route('https://api.bybit.com/**', (route) => {
    const u = new URL(route.request().url()), q = u.searchParams;
    let result;
    if (u.pathname.endsWith('/kline')) {
      const sec = SEC[q.get('interval')], limit = +q.get('limit') || 200;
      const end = q.get('end') ? Math.floor(+q.get('end') / 1000) : NOW;
      const lastStart = Math.floor(end / sec) * sec, list = [];
      for (let i = 0; i < limit; i++) list.push(kline(lastStart - i * sec, sec));
      result = { category: 'linear', symbol: q.get('symbol'), list };
    } else if (u.pathname.endsWith('/open-interest')) {
      const sec = OI_SEC[q.get('intervalTime')], page_ = +(q.get('cursor') || 0);
      const lastT = Math.floor(NOW / sec) * sec - page_ * 200 * sec, list = [];
      for (let i = 0; i < 200; i++) list.push({ openInterest: oiAt(lastT - i * sec).toFixed(3), timestamp: String((lastT - i * sec) * 1000) });
      result = { category: 'linear', symbol: q.get('symbol'), list, nextPageCursor: String(page_ + 1) };
    } else if (u.pathname.endsWith('/account-ratio')) {
      result = { list: [{ symbol: q.get('symbol'), buyRatio: '0.5321', sellRatio: '0.4679', timestamp: String(NOW * 1000) }] };
    }
    route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ retCode: 0, retMsg: 'OK', result, retExtInfo: {}, time: Date.now() }) });
  });

  let subscribed = [];
  await page.routeWebSocket('wss://stream.bybit.com/**', (ws) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(raw);
      if (m.op !== 'subscribe') return;
      subscribed = subscribed.concat(m.args);
      for (const topic of m.args) {
        const sym = topic.split('.').pop(), p = priceAt(NOW);
        if (topic.startsWith('tickers.')) ws.send(JSON.stringify({ topic, type: 'snapshot', ts: Date.now(), data: { symbol: sym, lastPrice: p.toFixed(1), markPrice: (p + 2).toFixed(1), price24hPcnt: '0.0123', fundingRate: '0.0001', openInterestValue: '5100000000' } }));
        if (topic.startsWith('allLiquidation.')) {
          ws.send(JSON.stringify({ topic, type: 'snapshot', ts: Date.now(), data: [
            { T: (NOW - 4000) * 1000, s: sym, S: 'Buy', v: '3.2', p: (priceAt(NOW - 4000) - 60).toFixed(1) },
            { T: (NOW - 9000) * 1000, s: sym, S: 'Sell', v: '0.9', p: (priceAt(NOW - 9000) + 60).toFixed(1) },
          ] }));
        }
        if (topic.startsWith('kline.')) {
          const iv = topic.split('.')[1], sec = SEC[iv], st = Math.floor(NOW / sec) * sec;
          ws.send(JSON.stringify({ topic, type: 'snapshot', ts: Date.now(), data: [{ start: st * 1000, end: (st + sec) * 1000 - 1, interval: iv, open: priceAt(st).toFixed(1), close: (p + 40).toFixed(1), high: (p + 90).toFixed(1), low: (priceAt(st) - 30).toFixed(1), volume: '12.5', turnover: '0', confirm: false, timestamp: Date.now() }] }));
        }
      }
    });
  });

  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForFunction(() => window.__et && window.__et.S.liq && window.__et.S.smc && window.__et.S.liqEvents.length >= 2, null, { timeout: 15000 });
  await page.waitForTimeout(600);

  const info = await page.evaluate(() => {
    const S = window.__et.S, m = S.liq;
    let nz = 0; for (let i = 0; i < m.grid.length; i += 97) if (m.grid[i] > 0) nz++;
    return {
      candles: S.candles.length, lastClose: S.candles[S.candles.length - 1].close,
      liq: { T: m.T, n: m.n, step: m.step, coverage: m.oiCoverage, nonZeroSampled: nz },
      smc: { structures: S.smc.structures.length, obs: S.smc.obs.length, fvgs: S.smc.fvgs.length, eq: S.smc.eq.length, trend: S.smc.trend },
      ew: S.ew && { stage: S.ew.stage, labels: S.ew.labels.length, mult: S.ew.mult },
      liqEvents: S.liqEvents, conn: document.getElementById('conn').className,
      market: document.getElementById('pMarket').innerText, clusters: document.getElementById('pClusters').innerText.slice(0, 200),
      status: document.getElementById('status').innerText,
    };
  });
  console.log(JSON.stringify(info, null, 1));
  assert.strictEqual(info.candles, 1000);
  assert.ok(info.liq.coverage > 0.95, 'OI와 캔들 시각 정렬');
  assert.ok(info.liq.nonZeroSampled > 100, '히트맵 데이터 존재');
  assert.ok(info.smc.structures > 0 && info.smc.obs > 0);
  assert.strictEqual(info.liqEvents[0].side, 'long');
  assert.strictEqual(info.conn, 'open');
  assert.strictEqual(subscribed.length, 3);
  assert.ok(Math.abs(info.lastClose - (priceAt(NOW) + 40)) < 0.2, '실시간 캔들 갱신 반영');

  // 과거 데이터 추가 로딩
  await page.evaluate(() => window.__et.chart.timeScale().setVisibleLogicalRange({ from: -50, to: 300 }));
  await page.waitForFunction(() => window.__et.S.candles.length === 2000, null, { timeout: 8000 });
  await page.evaluate(() => { const n = window.__et.S.candles.length; window.__et.chart.timeScale().setVisibleLogicalRange({ from: n - 260, to: n + 14 }); });

  // 수동 엘리엇: 3점 찍기
  await page.click('#btnSettings'); await page.click('#ewManual');
  const box = await page.locator('#chart').boundingBox();
  for (const [fx, fy] of [[0.3, 0.6], [0.4, 0.4], [0.5, 0.5]]) { await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(700); }
  const manual = await page.evaluate(() => ({ n: window.__et.S.manual.length, labels: window.__et.S.manualLabels.length, stage: window.__et.S.manualInfo.stage }));
  console.log('manual', manual);
  assert.strictEqual(manual.n, 3);
  assert.strictEqual(manual.labels, 3);
  await page.click('#ewClear'); await page.click('#ewDone');
  // 레이어 마스터 스위치
  await page.click('[data-layer="liq"]');
  assert.strictEqual(await page.evaluate(() => window.__et.S.on.heatmap), false);
  await page.click('[data-layer="liq"]');
  assert.strictEqual(await page.evaluate(() => window.__et.S.on.heatmap), true);

  // 타임프레임 전환
  await page.click('[data-tf="60"]');
  await page.waitForFunction(() => window.__et.S.tf === '60' && window.__et.S.candles.length === 1000 && window.__et.S.smc, null, { timeout: 8000 });
  await page.waitForTimeout(500);
  if (process.argv[2]) {
    await page.screenshot({ path: process.argv[2].replace('.png', '-1h.png') });
    await page.click('[data-tf="15"]');
    await page.waitForFunction(() => window.__et.S.tf === '15' && window.__et.S.candles.length === 1000, null, { timeout: 8000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: process.argv[2] });
    await page.click('#btnSettings'); await page.waitForTimeout(200);
    await page.screenshot({ path: process.argv[2].replace('.png', '-settings.png') });
    await page.click('#chart', { position: { x: 200, y: 300 } });
    await page.setViewportSize({ width: 390, height: 760 }); await page.waitForTimeout(500);
    await page.click('#btnPanel'); await page.waitForTimeout(300);
    await page.screenshot({ path: process.argv[2].replace('.png', '-mobile.png') });
  }
  assert.deepStrictEqual(errors, [], '콘솔 오류 없음');
  await browser.close();
  console.log('\ne2e passed');
})().catch((e) => { console.error(e); process.exit(1); });
