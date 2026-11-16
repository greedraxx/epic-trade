(function () {
  const ET = window.ET, X = ET.ex, LC = window.LightweightCharts;
  const $ = (id) => document.getElementById(id);
  const TFS = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['30', '30m'], ['60', '1h'], ['240', '4h'], ['D', '1D'], ['W', '1W']];
  const LIQ_RANGES = { '1d': ['5min', 288], '3d': ['5min', 864], '1w': ['15min', 672], '2w': ['30min', 672], '1m': ['1h', 720], '3m': ['4h', 540] };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('et.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('et.' + k, JSON.stringify(v)); } catch (e) {} },
  };

  const S = {
    symbol: store.get('symbol', 'BTCUSDT'),
    wantSource: store.get('wantSource', 'BYBIT'), // 사용자가 고른 차트 거래소
    source: 'BYBIT',                              // 실제로 캔들을 받고 있는 거래소
    exState: {}, wsState: {}, magnet: store.get('magnet', true), drawings: [],
    tf: store.get('tf', '15'),
    tfSec: 900,
    candles: [],
    // detail: 세부 표시 항목, layer: 상단 3개 마스터 스위치, on: 둘을 합친 실제 표시 여부
    detail: Object.assign({ heatmap: true, profile: true, liqs: true, structure: true, ob: true, fvg: true, eq: false, pd: false, ewAuto: true }, store.get('detail', {})),
    layer: Object.assign({ liq: true, smc: true, ew: true }, store.get('layer', {})),
    on: {},
    panel: store.get('panel', window.innerWidth > 900),
    liqRange: store.get('liqRange', '3d'),
    intensity: store.get('intensity', 1),
    smcLen: store.get('smcLen', 5),
    ewMult: store.get('ewMult', 0),
    minLiqUsd: 5000,
    liq: null, smc: null, ew: null,
    manual: [], manualLabels: [], manualInfo: null, manualMode: false,
    liqEvents: [], ticker: {}, ratio: null,
  };
  let loadToken = 0, loadingOlder = false, noOlder = false, streams = [], liqTimer = null;

  // ---------- 차트 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => { const d = new Date(t * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const chart = LC.createChart($('chart'), {
    autoSize: true,
    layout: { background: { color: '#0b0d12' }, textColor: '#6b7280', fontSize: 11, attributionLogo: true, panes: { separatorColor: '#1c2029' } },
    grid: { vertLines: { visible: false }, horzLines: { color: '#12151c' } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1c2029' },
    timeScale: {
      borderColor: '#1c2029', timeVisible: true, rightOffset: 12,
      tickMarkFormatter: (t, type) => { const d = new Date(t * 1000); return type === 0 ? String(d.getFullYear()) : type === 1 ? d.getMonth() + 1 + '월' : type === 2 ? d.getMonth() + 1 + '/' + d.getDate() : pad(d.getHours()) + ':' + pad(d.getMinutes()); },
    },
    localization: { timeFormatter: fmtTime },
  });
  const candleSeries = chart.addSeries(LC.CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350', priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
  const volSeries = chart.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.88, bottom: 0 } });
  const oiSeries = chart.addSeries(LC.LineSeries, { color: '#f5c542', lineWidth: 1, priceFormat: { type: 'volume' }, title: 'OI', priceLineVisible: false }, 1);
  chart.panes()[0].setStretchFactor(5); chart.panes()[1].setStretchFactor(1);
  const overlay = new ET.Overlay(S);
  candleSeries.attachPrimitive(overlay);
  window.__et = { S, chart, candleSeries, overlay }; // 디버깅/테스트용

  const status = (msg, info) => { const el = $('status'); el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; el.className = info ? 'info' : ''; };
  const volBar = (c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(38,166,154,0.4)' : 'rgba(239,83,80,0.4)' });

  // ---------- 분석 ----------
  function analyze() {
    const c = S.candles;
    if (c.length < 30) { S.smc = S.ew = null; return; }
    // 진행 중인 마지막 봉은 SMC 판정에서 제외(종가 확정 전 신호 방지)
    S.smc = ET.smc.analyze(c.slice(0, -1), { len: S.smcLen });
    S.ew = S.on.ewAuto ? ET.elliott.auto(c, ET.smc.atr(c, 14), { mult: S.ewMult || undefined }) : null;
    resolveManual();
    computeSignal();
    overlay.refresh();
    renderPanel();
  }

  // 단기 방향 점수. OI·청산 요인은 데이터가 있는 봉에서만 계산된다.
  function computeSignal() {
    const c = S.candles;
    if (c.length < 60 || !S.smc) { S.sig = null; return; }
    const m = S.liq, cols = m ? overlay._columns() : null;
    const liqAsym = !m ? null : (i) => {
      const k = cols[i];
      if (k == null || k < 0) return NaN;
      const price = c[i].close, pb = Math.floor((price - m.min) / m.step), w = Math.ceil((price * 0.03) / m.step);
      let up = 0, dn = 0;
      for (let b = Math.max(0, pb - w); b <= Math.min(m.n - 1, pb + w); b++) { const v = m.grid[k * m.n + b]; if (b > pb) up += v; else if (b < pb) dn += v; }
      return up + dn > 0 ? (up - dn) / (up + dn) : NaN;
    };
    // OI는 봉 종가 시점 스냅샷(다음 봉 시작 시각)을 쓴다
    const oiAt = S.oiMap && S.oiMap.size ? (t) => S.oiMap.get(t + S.tfSec) : null;
    S.sig = ET.signal.analyze(c, { atr: ET.smc.atr(c, 14), structures: S.smc.structures, oiAt, liqAsym });
  }


  function resolveManual() {
    const c = S.candles, labels = [];
    for (let i = 0; i < S.manual.length; i++) {
      const p = S.manual[i];
      let lo = 0, hi = c.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid].time <= p.time) lo = mid; else hi = mid - 1; }
      if (c.length && c[0].time <= p.time) labels.push({ idx: lo, price: p.price, text: ET.elliott.NAMES[i] });
    }
    S.manualLabels = labels;
    S.manualInfo = ET.elliott.manual(S.manual);
  }

  // ---------- 로딩 ----------
  async function loadAll() {
    const token = ++loadToken;
    S.tfSec = X.TF_SEC[S.tf];
    noOlder = false;
    status('불러오는 중…', true);
    // 선택한 거래소가 응답하지 않으면 나머지를 순서대로 시도한다. 전부 실패하면 빈 차트 + 오류.
    const order = [S.wantSource].concat(X.list.map((e) => e.id).filter((id) => id !== S.wantSource));
    let c = null;
    const errs = [];
    for (const id of order) {
      try {
        const r = await X[id].klines(S.symbol, S.tf, { limit: 1000 });
        if (token !== loadToken) return;
        if (r.length < 30) throw new Error('캔들 부족');
        c = r; S.source = id;
        break;
      } catch (e) { if (token !== loadToken) return; errs.push(X[id].name + ': ' + e.message); }
    }
    S.manual = store.get('manual.' + S.symbol, []);
    S.drawings = store.get('draw.' + S.symbol, []);
    S.liqEvents = store.get('liqs.' + S.symbol, []);
    S.selected = null;
    if (!c) {
      S.candles = []; S.smc = S.ew = S.liq = null;
      candleSeries.setData([]); volSeries.setData([]); oiSeries.setData([]);
      closeStreams(); overlay.refresh(); renderPanel();
      status('세 거래소 모두 캔들을 불러오지 못했습니다.\n' + errs.join('\n') + '\n\n· 인터넷 연결 / 거래소 접속 가능 지역인지 확인\n· 브라우저가 직접 호출을 막는 경우(CORS): `node server.js` 실행 후 http://localhost:8787 접속');
      return;
    }
    S.candles = c; S.oiMap = null;
    const prec = c[c.length - 1].close < 1000 ? 2 : 1;
    candleSeries.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: Math.pow(10, -prec) } });
    candleSeries.setData(c);
    volSeries.setData(c.map(volBar));
    oiSeries.setData([]);
    chart.timeScale().setVisibleLogicalRange({ from: c.length - 220, to: c.length + 12 });
    status('');
    analyze();
    openStreams();
    loadOi(token);
    loadLiq();
    loadRatio();
  }

  async function loadOi(token) {
    const iv = X.TF_TO_OI[S.tf];
    if (!iv) return;
    try {
      const oi = await X[S.source].oiHistory(S.symbol, iv, 1000);
      if (token !== loadToken) return;
      S.oiMap = new Map(oi.map((r) => [r.time, r.oi]));
      computeSignal(); renderPanel();
      const times = new Set(S.candles.map((c) => c.time));
      oiSeries.setData(oi.filter((r) => times.has(r.time)).map((r) => ({ time: r.time, value: r.oi })));
    } catch (e) { console.warn('OI', e); }
  }

  // 세 거래소의 캔들·OI를 각각 받아 합산 청산맵을 만든다. 실패한 거래소는 빼고 계산한다.
  async function loadLiq() {
    clearTimeout(liqTimer);
    const token = loadToken, sym = S.symbol, [iv, n] = LIQ_RANGES[S.liqRange];
    const res = await Promise.all(X.list.map(async (ex) => {
      try {
        const [klines, oi] = await Promise.all([ex.klines(sym, X.OI_TO_TF[iv], { limit: n }), ex.oiHistory(sym, iv, n + 1)]);
        if (klines.length < 3 || oi.length < 2) throw new Error('데이터 부족');
        return { id: ex.id, klines, oi, mmr: ex.mmr };
      } catch (e) { return { id: ex.id, error: e.message || String(e) }; }
    }));
    if (token !== loadToken) return;
    for (const r of res) S.exState[r.id] = r.error ? { ok: false, error: r.error } : { ok: true };
    try { S.liq = ET.liqmap.computeMulti(res.filter((r) => !r.error)); } catch (e) { console.warn('liqmap', e); S.liq = null; }
    computeSignal();
    overlay.refresh();
    renderPanel();
    liqTimer = setTimeout(loadLiq, 120000); // 2분마다 재계산
  }

  async function loadRatio() {
    try { S.ratio = await X.BYBIT.accountRatio(S.symbol); renderPanel(); } catch (e) { S.ratio = null; }
  }

  async function loadOlder() {
    if (loadingOlder || noOlder || !S.candles.length) return;
    loadingOlder = true;
    const token = loadToken;
    try {
      const older = await X[S.source].klines(S.symbol, S.tf, { limit: 1000, end: S.candles[0].time * 1000 - 1 });
      if (token !== loadToken) return;
      const first = S.candles[0].time, add = older.filter((c) => c.time < first);
      if (!add.length) { noOlder = true; return; }
      const r = chart.timeScale().getVisibleLogicalRange();
      S.candles = add.concat(S.candles);
      candleSeries.setData(S.candles);
      volSeries.setData(S.candles.map(volBar));
      if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + add.length, to: r.to + add.length });
      analyze();
    } catch (e) { console.warn('older', e); } finally { loadingOlder = false; }
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 30) loadOlder(); });

  // ---------- 실시간 ----------
  let analyzeTimer = null;
  function onKline(bar) {
    const c = S.candles, last = c[c.length - 1];
    if (!last || bar.time < last.time) return;
    const isNew = bar.time > last.time, b = { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
    if (isNew) c.push(b); else c[c.length - 1] = b;
    candleSeries.update(b); volSeries.update(volBar(b));
    if (isNew || bar.confirm) { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(analyze, 300); } else overlay.refresh();
  }
  function onLiq(id, e) {
    if (!(e.usd > 0)) return;
    S.liqEvents.push({ t: e.t, price: e.price, usd: e.usd, side: e.side, ex: id });
    if (S.liqEvents.length > 3000) S.liqEvents = S.liqEvents.slice(-3000);
    store.set('liqs.' + S.symbol, S.liqEvents);
    overlay.refresh(); renderFeed();
  }
  function closeStreams() { streams.forEach((s) => s.close()); streams = []; }
  // 차트 거래소는 캔들·시세·청산, 나머지 두 곳은 청산 스트림만 연다.
  function openStreams() {
    closeStreams();
    S.ticker = {}; S.wsState = {};
    const token = loadToken;
    streams = X.list.map((ex) => ex.open(S.symbol, {
      tf: ex.id === S.source ? S.tf : null,
      onKline: (b) => token === loadToken && onKline(b),
      onLiq: (e) => token === loadToken && onLiq(ex.id, e),
      onTicker: (t) => { if (token === loadToken) { S.ticker = t; renderMarket(); } },
      onStatus: (st) => {
        if (token !== loadToken) return;
        S.wsState[ex.id] = st;
        if (ex.id === S.source) { $('conn').className = st; $('conn').title = ex.name + ' 실시간: ' + st; }
        renderExchanges();
      },
    }));
  }

  // ---------- 패널 ----------
  const U = ET.fmtUsd;
  const px = (v) => (v == null || isNaN(v) ? '–' : (+v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const pct = (v, d) => (v >= 0 ? '+' : '') + (v * 100).toFixed(d == null ? 2 : d) + '%';
  function renderMarket() {
    const t = S.ticker, r = S.ratio, fr = t.fundingRate;
    const has = (v) => v != null && !isNaN(v);
    const oiSum = S.liq ? S.liq.sources.reduce((a, x) => a + (x.oiUsd || 0), 0) : 0;
    $('pMarket').innerHTML =
      '<span>현재가 (' + X[S.source].name + ')</span><span>' + px(t.lastPrice) + '</span>' +
      '<span>마크</span><span>' + px(t.markPrice) + '</span>' +
      '<span>24h</span><span class="' + (t.price24hPcnt >= 0 ? 'up' : 'dn') + '">' + (has(t.price24hPcnt) ? pct(t.price24hPcnt) : '–') + '</span>' +
      '<span>펀딩비</span><span class="' + (fr >= 0 ? 'up' : 'dn') + '">' + (has(fr) ? pct(fr, 4) : '–') + '</span>' +
      '<span>미결제약정 합계</span><span>' + (oiSum ? '$' + U(oiSum) : '–') + '</span>' +
      '<span>롱/숏 계정비 (Bybit 1h)</span><span>' + (r ? (r.buy * 100).toFixed(1) + ' / ' + (r.sell * 100).toFixed(1) : '–') + '</span>';
  }
  // 거래소별 연결 상태와 OI. 연결되지 않은 거래소는 합산에서 빠진다는 것을 그대로 보여 준다.
  function renderExchanges() {
    const src = S.liq ? S.liq.sources : [], tot = src.reduce((a, x) => a + (x.oiUsd || 0), 0);
    $('pEx').innerHTML = X.list.map((ex) => {
      const st = S.exState[ex.id], m = src.find((x) => x.id === ex.id), ws = S.wsState[ex.id] === 'open';
      const state = !st ? '<span class="mute">확인 중</span>' : st.ok ? '<span class="up">연결</span>' : '<span class="dn" title="' + String(st.error).replace(/"/g, '') + '">미연결</span>';
      return '<div class="row"><span>' + ex.name + (ex.id === S.source ? ' <span class="mute">· 차트</span>' : '') + '</span><span>' + state + (ws ? ' <span class="mute">· 실시간</span>' : '') + '</span><span>' +
        (m && m.oiUsd ? '$' + U(m.oiUsd) + ' <span class="mute">' + (tot ? ((m.oiUsd / tot) * 100).toFixed(0) + '%' : '') + '</span>' : '<span class="mute">–</span>') + '</span></div>';
    }).join('') + (src.length && src.length < X.list.length ? '<div class="note">미연결 거래소는 청산맵 합산에서 제외됩니다.</div>' : '');
  }
  function renderPanel() {
    renderMarket(); renderExchanges();
    const c = S.candles, price = c.length ? c[c.length - 1].close : 0;
    // 단기 방향
    if (S.sig) {
      const g = S.sig, nw = g.now, cls = (v) => (v > 0 ? 'up' : v < 0 ? 'dn' : 'mute'), sg = (v) => (isNaN(v) ? '–' : (v > 0 ? '+' : '') + v.toFixed(2));
      let h = '<div class="row"><b class="' + cls(nw.dir) + '">' + (nw.dir > 0 ? '상승 우위' : nw.dir < 0 ? '하락 우위' : '중립 (신호 없음)') + '</b><span class="' + cls(nw.score) + '">' + sg(nw.score) + '</span></div>';
      h += nw.parts.map((p) => '<div class="row" title="' + p.desc + '"><span class="mute">' + p.name + '</span><span class="' + cls(p.value) + '">' + (isNaN(p.value) ? '데이터 없음' : sg(p.value)) + '</span></div>').join('');
      h += '<div class="note" style="margin-top:8px">이 차트 데이터에서의 실제 적중률 (직전 확정봉 기준 점수 → N봉 뒤 종가 방향)</div>';
      h += '<table class="bt"><tr><th>기간</th><th>신호</th><th>적중률</th><th>순수익</th></tr>' + g.horizons.map((r) => r.n
        ? '<tr><td>' + r.h + '봉</td><td>' + r.n + '</td><td class="' + (r.lo > 0.5 ? 'up' : '') + '">' + (r.hit * 100).toFixed(1) + '% <span class="mute">±' + (r.ci * 100).toFixed(1) + '</span></td><td class="' + cls(r.net) + '">' + (r.net * 100).toFixed(3) + '%</td></tr>'
        : '<tr><td>' + r.h + '봉</td><td colspan="3" class="mute">신호 없음</td></tr>').join('') + '</table>';
      const any = g.horizons.some((r) => r.edge);
      h += '<div class="note"><b class="' + (any ? 'up' : 'dn') + '">' + (any ? '일부 기간에서 50% 초과가 관측됨' : '통계적으로 50%를 넘는 우위는 확인되지 않음') + '</b> · 순수익은 신호 1회당 평균, 왕복 수수료 ' + (g.fee * 100).toFixed(2) + '% 차감 가정.</div>';
      h += '<div class="note">요인별 적중률(4봉): ' + g.perFactor.map((r) => r.name + ' ' + (r.n ? (r.hit * 100).toFixed(0) + '%<span class="mute">(' + r.n + ')</span>' : '–')).join(' · ') + '</div>';
      h += '<div class="note">현재 화면에 불러온 봉만으로 잰 값입니다. 표본이 작고 시장 국면이 바뀌면 달라지며, 과거 적중률이 미래를 보장하지 않습니다.</div>';
      $('pSig').innerHTML = h;
    } else $('pSig').innerHTML = '<div class="mute">계산 중…</div>';
    // 청산 밀집
    if (S.liq && price) {
      const cl = ET.liqmap.clusters(S.liq, price, 3);
      const rows = (arr, cls) => arr.map((q) => '<div class="row"><span class="' + cls + '">' + px(q.price) + '</span><span class="mute">' + pct(q.dist) + '</span><span>$' + U(q.usd) + '</span></div>').join('') || '<div class="mute">없음</div>';
      $('pClusters').innerHTML =
        '<div class="mute">위 (숏 청산) — 합계 $' + U(cl.totalShort) + '</div>' + rows(cl.short.sort((a, b) => b.price - a.price), 'up') +
        '<div class="mute" style="margin-top:5px">아래 (롱 청산) — 합계 $' + U(cl.totalLong) + '</div>' + rows(cl.long.sort((a, b) => b.price - a.price), 'dn') +
        '<div class="note">' + S.liq.sources.map((x) => X[x.id].name).join(' + ') + ' OI 증가분 기반 <b>추정치</b>. 레버리지 분포는 가정값(10x 30% · 25x 35% · 50x 25% · 100x 10%)이라 금액은 상대 비교용입니다. OI 매칭률 ' + S.liq.sources.map((x) => (x.coverage * 100).toFixed(0) + '%').join(' / ') + '.</div>';
    } else $('pClusters').innerHTML = '<div class="mute">계산 중…</div>';
    // SMC
    if (S.smc) {
      const s = S.smc, lastSt = s.structures[s.structures.length - 1];
      const ob = s.obs.filter((o) => o.endIdx == null), fv = s.fvgs.filter((f) => f.endIdx == null);
      const near = (arr, dir) => { const z = arr.filter((o) => o.dir === dir).map((o) => (dir === 1 ? o.top : o.bottom)).filter((p) => (dir === 1 ? p < price : p > price)); return z.length ? px(dir === 1 ? Math.max.apply(null, z) : Math.min.apply(null, z)) : '–'; };
      let zone = '–';
      if (s.range) zone = price > s.range.eq ? '<span class="dn">프리미엄</span>' : '<span class="up">디스카운트</span>';
      $('pSmc').innerHTML =
        '<span>구조 추세</span><span class="' + (s.trend === 1 ? 'up' : s.trend === -1 ? 'dn' : '') + '">' + (s.trend === 1 ? '상승' : s.trend === -1 ? '하락' : '미정') + '</span>' +
        '<span>마지막 신호</span><span>' + (lastSt ? lastSt.type + (lastSt.dir === 1 ? ' ↑ ' : ' ↓ ') + px(lastSt.price) : '–') + '</span>' +
        '<span>가까운 +OB (아래)</span><span>' + near(ob, 1) + '</span>' +
        '<span>가까운 -OB (위)</span><span>' + near(ob, -1) + '</span>' +
        '<span>미충족 FVG</span><span>' + fv.length + '개</span>' +
        '<span>레인지 위치</span><span>' + zone + '</span>';
    }
    // 엘리엇
    const block = (title, info, viol) => {
      if (!info) return '';
      let h = '<div class="row"><b>' + title + '</b><span class="' + (info.dir === 1 ? 'up' : info.dir === -1 ? 'dn' : 'mute') + '">' + (info.dir === 1 ? '상승 충격' : info.dir === -1 ? '하락 충격' : '') + '</span></div>';
      h += '<div class="row"><span class="mute">단계</span><span>' + info.stage + '</span></div>';
      if (info.invalidation) h += '<div class="row"><span class="mute">무효화</span><span class="dn">' + px(info.invalidation.price) + '</span></div><div class="note">' + info.invalidation.reason + '</div>';
      for (const t of info.targets || []) h += '<div class="row"><span class="mute">' + t.label + '</span><span>' + px(t.price) + '</span></div>';
      if (viol && viol.length) h += '<ul class="bad">' + viol.map((v) => '<li>' + v + '</li>').join('') + '</ul>';
      else if (viol) h += '<div class="note up">규칙 위반 없음</div>';
      return h;
    };
    let ew = '';
    if (S.on.ewAuto) ew += S.ew ? block('자동 (' + S.ew.mult + ' ATR)', S.ew) : '<div class="mute">현재 구간에서 규칙을 만족하는 카운트 없음</div>';
    if (S.manual.length || S.manualMode) ew += '<div style="margin-top:8px">' + block('수동', S.manualInfo, S.manual.length > 1 ? S.manualInfo.violations : null) + '</div>';
    ew += '<div class="note">자동 카운트는 절대 규칙(2파 되돌림·3파 최단 금지·4파 겹침)을 통과한 <b>후보 1개</b>이며, 다른 유효한 카운트가 존재할 수 있습니다.</div>';
    $('pEw').innerHTML = ew;
    renderFeed();
  }
  function renderFeed() {
    const ev = S.liqEvents.slice(-40).reverse();
    $('pFeed').innerHTML = ev.length
      ? ev.map((e) => '<div class="row"><span class="' + (e.side === 'long' ? 'dn' : 'up') + '">' + (e.side === 'long' ? '롱' : '숏') + ' <span class="mute">' + (X[e.ex || 'BYBIT'].name) + '</span></span><span>' + px(e.price) + '</span><span>$' + U(e.usd) + '</span><span class="mute">' + fmtTime(e.t).slice(11) + '</span></div>').join('')
      : '<div class="mute">대기 중… (거래소들이 과거 청산 내역을 공개 API로 제공하지 않아 접속 이후 체결분만 표시됩니다)</div>';
  }

  // ---------- 범례 / 클릭 ----------
  chart.subscribeCrosshairMove((p) => {
    const c = S.candles;
    let bar = p && p.seriesData ? p.seriesData.get(candleSeries) : null;
    if (!bar && c.length) bar = c[c.length - 1];
    if (!bar) { $('legend').innerHTML = ''; return; }
    const up = bar.close >= bar.open;
    let h = '<span class="' + (up ? 'up' : 'dn') + '">O ' + px(bar.open) + ' H ' + px(bar.high) + ' L ' + px(bar.low) + ' C ' + px(bar.close) + ' (' + pct((bar.close - bar.open) / bar.open) + ')</span>';
    if (p && p.point && S.liq && S.on.heatmap) {
      const price = candleSeries.coordinateToPrice(p.point.y), m = S.liq;
      if (price != null) {
        const b = Math.floor((price - m.min) / m.step);
        const v = b >= 0 && b < m.n ? m.grid[(m.T - 1) * m.n + b] : 0;
        h += ' &nbsp;<span class="mute">· 커서 ' + px(price) + ' · 현재 추정 청산 대기 </span>' + (v > 0 ? '<span class="warnc">$' + U(v) + '</span>' : '<span class="mute">없음</span>');
      }
    }
    $('legend').innerHTML = h;
  });

  const tools = ET.tools.init({
    S, chart, series: candleSeries, el: $('chart'),
    refresh: () => overlay.refresh(),
    save: () => store.set('draw.' + S.symbol, S.drawings),
    onTool: () => syncUi(),
    // 수동 엘리엇: 클릭 위치에 가까운 쪽(고가/저가)에 스냅
    onWave: (p) => {
      const c = S.candles[p.idx];
      if (!c || S.manual.length >= 9) return;
      S.manual.push({ time: c.time, price: Math.abs(p.price - c.high) < Math.abs(p.price - c.low) ? c.high : c.low });
      saveManual();
    },
  });
  window.__et.tools = tools;
  function saveManual() { store.set('manual.' + S.symbol, S.manual); resolveManual(); overlay.refresh(); renderPanel(); $('manualCount').textContent = S.manual.length < 9 ? '다음: ' + ET.elliott.NAMES[S.manual.length] : '완료 (9/9)'; }

  // ---------- 툴바 ----------
  const GROUP = { heatmap: 'liq', profile: 'liq', liqs: 'liq', structure: 'smc', ob: 'smc', fvg: 'smc', eq: 'smc', pd: 'smc', ewAuto: 'ew' };
  const applyLayers = () => { for (const k in GROUP) S.on[k] = !!S.detail[k] && !!S.layer[GROUP[k]]; };
  $('tfs').innerHTML = TFS.map((t) => '<button data-tf="' + t[0] + '">' + t[1] + '</button>').join('');
  const syncUi = () => {
    applyLayers();
    document.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', b.dataset.tf === S.tf));
    document.querySelectorAll('[data-on]').forEach((b) => b.classList.toggle('on', !!S.detail[b.dataset.on]));
    document.querySelectorAll('[data-layer]').forEach((b) => b.classList.toggle('on', !!S.layer[b.dataset.layer]));
    document.body.classList.toggle('panel-closed', !S.panel);
    $('btnPanel').classList.toggle('on', S.panel);
    S.manualMode = S.tool === 'wave';
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
    $('magnet').classList.toggle('on', S.magnet);
    $('manualBar').style.display = S.manualMode ? 'flex' : 'none';
    $('manualCount').textContent = S.manual.length < 9 ? '다음: ' + ET.elliott.NAMES[S.manual.length] : '완료 (9/9)';
  };
  $('tfs').addEventListener('click', (e) => { const tf = e.target.dataset.tf; if (!tf || tf === S.tf) return; S.tf = tf; store.set('tf', tf); syncUi(); loadAll(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const k = b && b.dataset.on, l = b && b.dataset.layer;
    if (b && b.dataset.tool) tools.setTool(S.tool === b.dataset.tool ? 'cursor' : b.dataset.tool);
    if (k) { S.detail[k] = !S.detail[k]; store.set('detail', S.detail); }
    else if (l) { S.layer[l] = !S.layer[l]; store.set('layer', S.layer); }
    if (k || l) { syncUi(); analyze(); overlay.refresh(); }
    // 설정 창: 바깥을 누르면 닫힘
    if (!e.target.closest('#settings') && !e.target.closest('#btnSettings')) $('settings').classList.remove('open');
  });
  $('btnSettings').addEventListener('click', () => $('settings').classList.toggle('open'));
  $('btnPanel').addEventListener('click', () => { S.panel = !S.panel; store.set('panel', S.panel); syncUi(); });
  const bind = (id, key, num, fn) => { $(id).value = S[key]; $(id).addEventListener('input', (e) => { S[key] = num ? +e.target.value : e.target.value; store.set(key, S[key]); fn(); }); };
  bind('symbol', 'symbol', false, () => { S.liq = null; S.exState = {}; loadAll(); });
  bind('source', 'wantSource', false, loadAll);
  $('magnet').addEventListener('click', () => { S.magnet = !S.magnet; store.set('magnet', S.magnet); syncUi(); });
  $('trash').addEventListener('click', () => { if (!tools.removeSelected() && S.drawings.length && confirm('그린 도형을 모두 지울까요?')) tools.clearAll(); });
  bind('liqRange', 'liqRange', false, () => { S.liq = null; overlay.refresh(); renderPanel(); loadLiq(); });
  bind('intensity', 'intensity', true, () => overlay.refresh());
  bind('smcLen', 'smcLen', true, analyze);
  bind('ewMult', 'ewMult', true, analyze);
  const setManual = (v) => { $('settings').classList.remove('open'); tools.setTool(v ? 'wave' : 'cursor'); renderPanel(); };
  $('ewManual').addEventListener('click', () => setManual(true));
  $('ewDone').addEventListener('click', () => setManual(false));
  $('ewUndo').addEventListener('click', () => { S.manual.pop(); saveManual(); syncUi(); });
  $('ewClear').addEventListener('click', () => { S.manual = []; saveManual(); syncUi(); });

  syncUi();
  loadAll();
  setInterval(loadRatio, 300000);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
