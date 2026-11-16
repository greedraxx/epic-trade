// node tests/e2e.js [스크린샷 경로]
// 세 거래소의 응답을 문서 형식 그대로 흉내 낸 "모의 데이터"로 브라우저에서 앱 전체를 돌려 본다.
// (실제 시세가 아님 — 어댑터 파싱·합산·화면 배선 검증용)
const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const SEC = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, D: 86400, W: 604800 };
const NAME_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1H': 3600, '4h': 14400, '4H': 14400, '1d': 86400, '1Dutc': 86400, '5min': 300, '15min': 900, '30min': 1800 };
const NOW = Math.floor(Date.now() / 1000);
const noise = (x) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
const priceAt = (t) => 95000 + 6000 * Math.sin(t / 90000) + 2500 * Math.sin(t / 17000) + 900 * Math.sin(t / 3100) + 300 * Math.sin(t / 700) + 120 * (noise(Math.floor(t / 300)) - 0.5);
const oiAt = (t) => 52000 + 4000 * Math.sin(t / 40000) + 1500 * Math.sin(t / 5000) + 300 * noise(Math.floor(t / 300) + 7);
// 거래소별 가격 차이(오프셋)와 OI 규모
const EXM = { bybit: { off: 0, oi: 1 }, binance: { off: 6, oi: 2.4 }, okx: { off: -4, oi: 0.6 } };
function ohlc(t, sec, off) {
  let o = priceAt(t) + off, c = priceAt(Math.min(t + sec, NOW)) + off, h = Math.max(o, c), l = Math.min(o, c);
  for (let k = 1; k < 8; k++) { const p = priceAt(Math.min(t + (sec * k) / 8, NOW)) + off; h = Math.max(h, p); l = Math.min(l, p); }
  return { t, o: o.toFixed(1), h: (h + 15).toFixed(1), l: (l - 15).toFixed(1), c: c.toFixed(1), v: (50 + 400 * noise(t)).toFixed(3) };
}
const json = (route, body) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });

async function setup(browser, down) {
  down = down || [];
  const page = await browser.newPage({ viewport: { width: 1500, height: 860 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.route('https://api.bybit.com/**', (route) => {
    if (down.includes('bybit')) return route.abort();
    const u = new URL(route.request().url()), q = u.searchParams;
    let result;
    if (u.pathname.endsWith('/kline')) {
      const sec = SEC[q.get('interval')], limit = +q.get('limit') || 200, end = q.get('end') ? Math.floor(+q.get('end') / 1000) : NOW;
      const last = Math.floor(end / sec) * sec, list = [];
      for (let i = 0; i < limit; i++) { const k = ohlc(last - i * sec, sec, 0); list.push([String(k.t * 1000), k.o, k.h, k.l, k.c, k.v, '0']); }
      result = { list };
    } else if (u.pathname.endsWith('/open-interest')) {
      const sec = NAME_SEC[q.get('intervalTime')] || 3600, pg = +(q.get('cursor') || 0), last = Math.floor(NOW / sec) * sec - pg * 200 * sec, list = [];
      for (let i = 0; i < 200; i++) list.push({ openInterest: oiAt(last - i * sec).toFixed(3), timestamp: String((last - i * sec) * 1000) });
      result = { list, nextPageCursor: String(pg + 1) };
    } else result = { list: [{ buyRatio: '0.5321', sellRatio: '0.4679', timestamp: String(NOW * 1000) }] };
    json(route, { retCode: 0, retMsg: 'OK', result });
  });

  await page.route('https://fapi.binance.com/**', (route) => {
    if (down.includes('binance')) return route.abort();
    const u = new URL(route.request().url()), q = u.searchParams;
    if (u.pathname.endsWith('/klines')) {
      const sec = NAME_SEC[q.get('interval')], limit = +q.get('limit'), end = q.get('endTime') ? Math.floor(+q.get('endTime') / 1000) : NOW;
      const last = Math.floor(end / sec) * sec, out = [];
      for (let i = limit - 1; i >= 0; i--) { const k = ohlc(last - i * sec, sec, EXM.binance.off); out.push([k.t * 1000, k.o, k.h, k.l, k.c, k.v, 0, '0', 0, '0', '0', '0']); }
      return json(route, out);
    }
    const sec = NAME_SEC[q.get('period')], limit = +q.get('limit'), end = q.get('endTime') ? Math.floor(+q.get('endTime') / 1000) : NOW;
    const last = Math.floor(end / sec) * sec, out = [];
    for (let i = limit - 1; i >= 0; i--) { const t = last - i * sec; out.push({ symbol: 'BTCUSDT', sumOpenInterest: (oiAt(t + 900) * EXM.binance.oi).toFixed(3), sumOpenInterestValue: '0', timestamp: t * 1000 }); }
    json(route, out);
  });

  await page.route('https://www.okx.com/**', (route) => {
    if (down.includes('okx')) return route.abort();
    const u = new URL(route.request().url()), q = u.searchParams;
    let data;
    if (u.pathname.endsWith('/candles')) {
      const sec = NAME_SEC[q.get('bar')], limit = Math.min(300, +q.get('limit') || 100), before = q.get('after') ? Math.floor(+q.get('after') / 1000) : NOW + 1;
      let t = Math.floor((before - 1) / sec) * sec; if (t * 1000 >= +q.get('after') && q.get('after')) t -= sec;
      data = [];
      for (let i = 0; i < limit; i++) { const k = ohlc(t - i * sec, sec, EXM.okx.off); data.push([String(k.t * 1000), k.o, k.h, k.l, k.c, String(Math.round(k.v * 100)), k.v, '0', i === 0 && !q.get('after') ? '0' : '1']); }
    } else if (u.pathname.endsWith('/open-interest-history')) {
      const sec = NAME_SEC[q.get('period')], before = q.get('end') ? Math.floor(+q.get('end') / 1000) : NOW + 1;
      let t = Math.floor((before - 1) / sec) * sec; if (q.get('end') && t * 1000 >= +q.get('end')) t -= sec;
      data = [];
      for (let i = 0; i < 100; i++) { const oi = oiAt(t - i * sec - 1300) * EXM.okx.oi; data.push([String((t - i * sec) * 1000), (oi * 100).toFixed(0), oi.toFixed(3), '0']); }
    } else data = [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01' }];
    json(route, { code: '0', msg: '', data });
  });

  const subs = { bybit: [], okx: [], binance: 0 };
  await page.routeWebSocket('wss://stream.bybit.com/**', (ws) => {
    if (down.includes('bybit')) return ws.close();
    ws.onMessage((raw) => {
      const m = JSON.parse(raw);
      if (m.op !== 'subscribe') return;
      subs.bybit = subs.bybit.concat(m.args);
      for (const topic of m.args) {
        const p = priceAt(NOW);
        if (topic.startsWith('tickers.')) ws.send(JSON.stringify({ topic, data: { lastPrice: p.toFixed(1), markPrice: (p + 2).toFixed(1), price24hPcnt: '0.0123', fundingRate: '0.0001' } }));
        if (topic.startsWith('allLiquidation.')) ws.send(JSON.stringify({ topic, data: [{ T: (NOW - 4000) * 1000, s: 'BTCUSDT', S: 'Buy', v: '3.2', p: (priceAt(NOW - 4000) - 60).toFixed(1) }] }));
        if (topic.startsWith('kline.')) { const iv = topic.split('.')[1], sec = SEC[iv], st = Math.floor(NOW / sec) * sec; ws.send(JSON.stringify({ topic, data: [{ start: st * 1000, open: priceAt(st).toFixed(1), close: (p + 40).toFixed(1), high: (p + 90).toFixed(1), low: (priceAt(st) - 30).toFixed(1), volume: '12.5', confirm: false }] })); }
      }
    });
  });
  await page.routeWebSocket('wss://fstream.binance.com/**', (ws) => {
    if (down.includes('binance')) return ws.close();
    subs.binance++;
    const streams = decodeURIComponent(ws.url().split('streams=')[1] || '').split('/');
    const p = priceAt(NOW) + EXM.binance.off;
    for (const s of streams) {
      if (s.endsWith('@forceOrder')) ws.send(JSON.stringify({ stream: s, data: { e: 'forceOrder', o: { s: 'BTCUSDT', S: 'SELL', q: '2.000', p: '91000.0', ap: '91010.0', T: (NOW - 7000) * 1000 } } }));
      if (s.includes('@kline_')) { const sec = NAME_SEC[s.split('_')[1]], st = Math.floor(NOW / sec) * sec; ws.send(JSON.stringify({ stream: s, data: { e: 'kline', k: { t: st * 1000, o: (priceAt(st) + 6).toFixed(1), h: (p + 90).toFixed(1), l: (priceAt(st) - 30).toFixed(1), c: (p + 55).toFixed(1), v: '9.5', x: false } } })); }
      if (s.endsWith('@ticker')) ws.send(JSON.stringify({ stream: s, data: { e: '24hrTicker', c: p.toFixed(1), P: '-2.50' } }));
      if (s.includes('@markPrice')) ws.send(JSON.stringify({ stream: s, data: { e: 'markPriceUpdate', p: (p + 1).toFixed(1), r: '0.00020000' } }));
    }
  });
  await page.routeWebSocket('wss://ws.okx.com:8443/**', (ws) => {
    if (down.includes('okx')) return ws.close();
    ws.onMessage((raw) => {
      if (raw === 'ping') return ws.send('pong');
      const m = JSON.parse(raw);
      for (const a of m.args || []) {
        subs.okx.push(a.channel);
        if (a.channel === 'liquidation-orders') ws.send(JSON.stringify({ arg: a, data: [
          { instId: 'ETH-USDT-SWAP', details: [{ side: 'sell', posSide: 'net', bkPx: '3000', sz: '50', ts: String(NOW * 1000) }] },
          { instId: 'BTC-USDT-SWAP', details: [{ side: 'buy', posSide: 'short', bkPx: '93000.0', sz: '150', ts: String((NOW - 2000) * 1000) }] },
        ] }));
      }
    });
  });

  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  return { page, errors, subs };
}
const state = (page) => page.evaluate(() => {
  const S = window.__et.S;
  return {
    source: S.source, candles: S.candles.length, last: S.candles.length ? S.candles[S.candles.length - 1].close : null,
    sources: S.liq ? S.liq.sources.map((x) => ({ id: x.id, cov: x.coverage, oiUsd: x.oiUsd, usd: x.usd })) : null,
    ex: S.exState, liqs: S.liqEvents, ticker: S.ticker, smc: !!S.smc, status: document.getElementById('status').innerText,
    exPanel: document.getElementById('pEx').innerText,
  };
});
const ready = (page) => page.waitForFunction(() => { const S = window.__et && window.__et.S; return S && S.liq && S.smc && Object.keys(S.exState).length === 3; }, null, { timeout: 20000 });

(async () => {
  const browser = await chromium.launch();

  // ── A. 세 거래소 모두 연결 ──
  {
    const { page, errors, subs } = await setup(browser);
    await ready(page);
    await page.waitForFunction(() => window.__et.S.liqEvents.length >= 3, null, { timeout: 8000 });
    await page.waitForTimeout(500);
    const s = await state(page);
    console.log('A', JSON.stringify({ source: s.source, sources: s.sources, ex: s.ex, liqs: s.liqs, ticker: s.ticker }));
    assert.strictEqual(s.source, 'BYBIT');
    assert.strictEqual(s.candles, 1000);
    assert.deepStrictEqual(s.sources.map((x) => x.id), ['BYBIT', 'BINANCE', 'OKX']);
    for (const x of s.sources) assert.ok(x.cov > 0.95 && x.usd > 0, x.id + ' OI와 캔들 시각 정렬');
    assert.ok(Math.abs(s.sources[1].oiUsd / s.sources[0].oiUsd - 2.4) < 0.3 && Math.abs(s.sources[2].oiUsd / s.sources[0].oiUsd - 0.6) < 0.1, 'OI 규모가 거래소별 실제 값에서 나옴');
    const by = (id) => s.liqs.find((e) => e.ex === id);
    assert.strictEqual(by('BYBIT').side, 'long');
    assert.strictEqual(by('BINANCE').side, 'long'); assert.ok(Math.abs(by('BINANCE').usd - 182020) < 1);
    assert.strictEqual(by('OKX').side, 'short'); assert.ok(Math.abs(by('OKX').usd - 93000 * 150 * 0.01) < 1, 'OKX 계약 수 → 기초자산 환산');
    assert.strictEqual(s.liqs.length, 3, '다른 종목 청산은 걸러짐');
    assert.strictEqual(subs.bybit.length, 3); assert.strictEqual(subs.binance, 1); assert.deepStrictEqual(subs.okx, ['liquidation-orders']);
    assert.ok(Math.abs(s.last - (priceAt(NOW) + 40)) < 0.2, '실시간 캔들 반영');

    // 단기 방향 점수와 자체 백테스트
    await page.waitForFunction(() => window.__et.S.sig && window.__et.S.oiMap, null, { timeout: 8000 });
    const sig = await page.evaluate(() => { const g = window.__et.S.sig; return { now: g.now.score, parts: g.now.parts.map((p) => p.key + ":" + p.value.toFixed(2)), oi: window.__et.S.oiMap.size, hz: g.horizons.map((r) => ({ h: r.h, n: r.n, hit: r.hit && +r.hit.toFixed(3), net: r.net && +r.net.toFixed(5) })), text: document.getElementById('pSig').innerText.slice(0, 40) }; });
    console.log('SIG (모의 데이터 — 수치에 의미 없음)', JSON.stringify(sig));
    assert.strictEqual(sig.hz.length, 3); assert.ok(sig.hz[0].n > 50);
    if (process.argv[2]) await page.locator('#panel').screenshot({ path: process.argv[2].replace('.png', '-panel.png') });

    // 과거 봉 추가 로딩
    await page.evaluate(() => window.__et.chart.timeScale().setVisibleLogicalRange({ from: -50, to: 300 }));
    await page.waitForFunction(() => window.__et.S.candles.length === 2000, null, { timeout: 8000 });
    await page.evaluate(() => { const n = window.__et.S.candles.length; window.__et.chart.timeScale().setVisibleLogicalRange({ from: n - 260, to: n + 14 }); });
    await page.waitForTimeout(300);

    // 그리기 도구
    const box = await page.locator('#chart').boundingBox();
    const at = (fx, fy) => page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.click('[data-tool="trend"]'); await at(0.3, 0.3); await at(0.5, 0.5);
    await page.click('[data-tool="hline"]'); await at(0.4, 0.2);
    await page.click('[data-tool="fib"]'); await at(0.55, 0.6); await at(0.7, 0.3);
    await page.click('[data-tool="long"]'); await at(0.72, 0.45); await at(0.8, 0.55);
    await page.click('[data-tool="ruler"]'); await at(0.2, 0.55); await at(0.28, 0.35);
    let d = await page.evaluate(() => ({ types: window.__et.S.drawings.map((x) => x.type), tool: window.__et.S.tool, stored: JSON.parse(localStorage.getItem('et.draw.BTCUSDT')).length }));
    assert.deepStrictEqual(d.types, ['trend', 'hline', 'fib', 'long', 'ruler']);
    assert.strictEqual(d.tool, 'cursor'); assert.strictEqual(d.stored, 5);
    if (process.argv[2]) await page.screenshot({ path: process.argv[2] });
    // 선택 후 삭제
    await at(0.4, 0.2);
    assert.strictEqual(await page.evaluate(() => (window.__et.S.drawings.find((x) => x.id === window.__et.S.selected) || {}).type), 'hline');
    await page.keyboard.press('Delete');
    assert.strictEqual(await page.evaluate(() => window.__et.S.drawings.length), 4);
    // 드래그는 점을 찍지 않는다
    await page.click('[data-tool="rect"]');
    await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 380, box.y + 300, { steps: 4 }); await page.mouse.up();
    assert.strictEqual(await page.evaluate(() => window.__et.S.pending), null);
    await page.keyboard.press('Escape');

    // 수동 엘리엇 (빠른 연속 클릭 포함)
    await page.click('#btnSettings'); await page.click('#ewManual');
    await at(0.3, 0.7); await at(0.4, 0.4); await at(0.5, 0.5);
    assert.strictEqual(await page.evaluate(() => window.__et.S.manual.length), 3);
    await page.click('#ewClear'); await page.click('#ewDone');

    // 레이어 스위치, 타임프레임 전환 후 도형 유지
    await page.click('[data-layer="liq"]'); assert.strictEqual(await page.evaluate(() => window.__et.S.on.heatmap), false); await page.click('[data-layer="liq"]');
    await page.click('[data-tf="60"]');
    await page.waitForFunction(() => window.__et.S.tf === '60' && window.__et.S.candles.length === 1000 && window.__et.S.smc, null, { timeout: 8000 });
    assert.strictEqual(await page.evaluate(() => window.__et.S.drawings.length), 4);
    if (process.argv[2]) { await page.setViewportSize({ width: 390, height: 760 }); await page.waitForTimeout(500); await page.click('#btnPanel'); await page.waitForTimeout(300); await page.screenshot({ path: process.argv[2].replace('.png', '-mobile.png') }); }
    assert.deepStrictEqual(errors, []);
    await page.close();
  }

  // ── B. Binance·OKX 미연결: Bybit만으로 계산하고 미연결로 표시 ──
  {
    const { page, errors } = await setup(browser, ['binance', 'okx']);
    await ready(page);
    const s = await state(page);
    console.log('B', JSON.stringify({ sources: s.sources.map((x) => x.id), ex: s.ex }), s.exPanel.replace(/\n/g, ' | '));
    assert.deepStrictEqual(s.sources.map((x) => x.id), ['BYBIT']);
    assert.strictEqual(s.ex.BINANCE.ok, false); assert.strictEqual(s.ex.OKX.ok, false);
    assert.ok(s.exPanel.includes('미연결'));
    assert.deepStrictEqual(errors, []);
    await page.close();
  }

  // ── C. Bybit 미연결: 차트가 Binance 캔들로 넘어가고 실시간도 Binance에서 받는다 ──
  {
    const { page, errors } = await setup(browser, ['bybit']);
    await ready(page);
    await page.waitForFunction(() => window.__et.S.ticker.markPrice > 0, null, { timeout: 8000 });
    const s = await state(page);
    console.log('C', JSON.stringify({ source: s.source, sources: s.sources.map((x) => x.id), ticker: s.ticker }));
    assert.strictEqual(s.source, 'BINANCE');
    assert.deepStrictEqual(s.sources.map((x) => x.id), ['BINANCE', 'OKX']);
    assert.ok(Math.abs(s.last - (priceAt(NOW) + 6 + 55)) < 0.2, 'Binance 실시간 캔들');
    assert.ok(Math.abs(s.ticker.price24hPcnt + 0.025) < 1e-9 && Math.abs(s.ticker.fundingRate - 0.0002) < 1e-9);
    // 차트 거래소를 OKX로 바꾸면 OKX 캔들(페이지 나눠 받기)로 전환
    await page.click('#btnSettings'); await page.selectOption('#source', 'OKX');
    await page.waitForFunction(() => window.__et.S.source === 'OKX' && window.__et.S.candles.length === 1000, null, { timeout: 8000 });
    const t = await page.evaluate(() => { const c = window.__et.S.candles; let ok = true; for (let i = 1; i < c.length; i++) if (c[i].time - c[i - 1].time !== 900) ok = false; return ok; });
    assert.ok(t, 'OKX 캔들이 빠짐없이 이어짐');
    assert.deepStrictEqual(errors, []);
    await page.close();
  }

  // ── D. 전부 미연결: 가짜 데이터 없이 빈 차트 + 오류 ──
  {
    const { page } = await setup(browser, ['bybit', 'binance', 'okx']);
    await page.waitForFunction(() => document.getElementById('status').innerText.includes('불러오지 못했습니다'), null, { timeout: 30000 });
    const s = await state(page);
    assert.strictEqual(s.candles, 0); assert.strictEqual(s.sources, null);
    console.log('D', s.status.split('\n').slice(0, 4).join(' | '));
    await page.close();
  }

  await browser.close();
  console.log('\ne2e passed');
})().catch((e) => { console.error(e); process.exit(1); });
