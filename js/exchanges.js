// 3대 거래소(Bybit · Binance · OKX) 공개 시장 데이터 어댑터. API 키 불필요.
// 모든 어댑터는 같은 형태를 반환한다:
//   klines(symbol, tf, {limit, end})  → 오름차순 [{time(초), open, high, low, close, volume(기초자산)}]
//   oiHistory(symbol, iv, points)     → 오름차순 [{time(초), oi(기초자산 수량)}]
//   open(symbol, {tf, onKline, onLiq, onTicker, onStatus}) → {close()}   (tf가 null이면 청산 스트림만)
// 연결되지 않는 거래소는 호출이 실패할 뿐이며, 가짜 데이터로 대체하지 않는다.
(function (root) {
  const ET = (root.ET = root.ET || {});

  // 접속 주소. 거래소가 주소를 바꾸면 여기만 고치면 된다.
  const CFG = (ET.config = {
    BYBIT: { rest: 'https://api.bybit.com', ws: 'wss://stream.bybit.com/v5/public/linear' },
    BINANCE: { rest: 'https://fapi.binance.com', ws: 'wss://fstream.binance.com/stream' },
    OKX: { rest: 'https://www.okx.com', wsPublic: 'wss://ws.okx.com:8443/ws/v5/public', wsBusiness: 'wss://ws.okx.com:8443/ws/v5/business' },
  });

  const TF_SEC = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, '240': 14400, 'D': 86400, 'W': 604800 };
  const OI_SEC = { '5min': 300, '15min': 900, '30min': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  const OI_TO_TF = { '5min': '5', '15min': '15', '30min': '30', '1h': '60', '4h': '240', '1d': 'D' };
  const TF_TO_OI = { '5': '5min', '15': '15min', '30': '30min', '60': '1h', '240': '4h', 'D': '1d' };

  // 직접 호출 → 실패 시 로컬 프록시(server.js의 /proxy/<거래소>) 순으로 시도
  const baseIdx = {};
  async function get(id, path, params) {
    const bases = [CFG[id].rest, '/proxy/' + id.toLowerCase()];
    const qs = new URLSearchParams(params).toString();
    let lastErr;
    for (let k = 0; k < bases.length; k++) {
      const i = ((baseIdx[id] || 0) + k) % bases.length;
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
      try {
        const r = await fetch(bases[i] + path + '?' + qs, { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        baseIdx[id] = i;
        return j;
      } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }
  const dedupe = (rows) => { const seen = new Set(); return rows.filter((r) => (seen.has(r.time) ? false : (seen.add(r.time), true))).sort((a, b) => a.time - b.time); };

  // 자동 재연결 WebSocket
  class RWS {
    constructor(url, o) { this.url = url; this.o = o; this.closed = false; this.retry = 0; this._connect(); }
    _connect() {
      if (this.closed) return;
      this.o.onStatus && this.o.onStatus('connecting');
      let ws;
      try { ws = this.ws = new WebSocket(this.url); } catch (e) { this._again(); return; }
      ws.onopen = () => {
        this.retry = 0;
        this.o.onStatus && this.o.onStatus('open');
        this.o.onOpen && this.o.onOpen((m) => ws.readyState === 1 && ws.send(typeof m === 'string' ? m : JSON.stringify(m)));
        if (this.o.ping) this.timer = setInterval(() => ws.readyState === 1 && ws.send(this.o.ping), 20000);
      };
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } try { this.o.onMsg(m); } catch (e) { console.error(e); } };
      ws.onclose = () => { clearInterval(this.timer); if (!this.closed) { this.o.onStatus && this.o.onStatus('closed'); this._again(); } };
      ws.onerror = () => { try { ws.close(); } catch (e) {} };
    }
    _again() { setTimeout(() => this._connect(), Math.min(60000, 1000 * Math.pow(2, this.retry++))); }
    close() { this.closed = true; clearInterval(this.timer); try { this.ws.close(); } catch (e) {} }
  }

  // ───────── Bybit ─────────
  const BYBIT = {
    id: 'BYBIT', name: 'Bybit', mmr: 0.005,
    async _get(path, p) { const j = await get('BYBIT', path, p); if (j.retCode !== 0) throw new Error('Bybit ' + j.retCode + ': ' + j.retMsg); return j.result; },
    async klines(symbol, tf, o) {
      o = o || {};
      const p = { category: 'linear', symbol, interval: tf, limit: Math.min(1000, o.limit || 1000) };
      if (o.end) p.end = o.end;
      const res = await this._get('/v5/market/kline', p);
      return dedupe(res.list.map((r) => ({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })));
    },
    async oiHistory(symbol, iv, points) {
      const out = [];
      let cursor = '';
      while (out.length < points) {
        const p = { category: 'linear', symbol, intervalTime: iv, limit: 200 };
        if (cursor) p.cursor = cursor;
        const res = await this._get('/v5/market/open-interest', p), list = res.list || [];
        for (const r of list) out.push({ time: Math.floor(+r.timestamp / 1000), oi: +r.openInterest });
        cursor = res.nextPageCursor;
        if (!cursor || list.length < 200) break;
      }
      return dedupe(out).slice(-points);
    },
    async accountRatio(symbol) {
      const res = await this._get('/v5/market/account-ratio', { category: 'linear', symbol, period: '1h', limit: 1 });
      const r = (res.list || [])[0];
      return r ? { buy: +r.buyRatio, sell: +r.sellRatio } : null;
    },
    open(symbol, h) {
      const topics = ['allLiquidation.' + symbol];
      if (h.tf) topics.push('kline.' + h.tf + '.' + symbol, 'tickers.' + symbol);
      const tk = {};
      const ws = new RWS(CFG.BYBIT.ws, {
        ping: JSON.stringify({ op: 'ping' }), onStatus: h.onStatus,
        onOpen: (send) => send({ op: 'subscribe', args: topics }),
        onMsg: (m) => {
          if (!m.topic) return;
          if (m.topic.startsWith('kline.')) for (const d of m.data || []) h.onKline({ time: Math.floor(d.start / 1000), open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume, confirm: !!d.confirm });
          else if (m.topic.startsWith('allLiquidation.')) {
            // S=Buy → 롱 포지션이 청산됨 (Bybit 문서)
            for (const d of [].concat(m.data || [])) h.onLiq({ t: Math.floor(d.T / 1000), price: +d.p, usd: +d.p * +d.v, side: d.S === 'Buy' ? 'long' : 'short' });
          } else if (m.topic.startsWith('tickers.')) {
            Object.assign(tk, m.data || {});
            h.onTicker({ lastPrice: +tk.lastPrice, markPrice: +tk.markPrice, price24hPcnt: +tk.price24hPcnt, fundingRate: +tk.fundingRate });
          }
        },
      });
      return { close: () => ws.close() };
    },
  };

  // ───────── Binance USDⓈ-M ─────────
  const BN_TF = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h', '240': '4h', 'D': '1d', 'W': '1w' };
  const BN_OI = { '5min': '5m', '15min': '15m', '30min': '30m', '1h': '1h', '4h': '4h', '1d': '1d' };
  const BINANCE = {
    id: 'BINANCE', name: 'Binance', mmr: 0.004,
    async klines(symbol, tf, o) {
      o = o || {};
      const p = { symbol, interval: BN_TF[tf], limit: Math.min(1500, o.limit || 1000) };
      if (o.end) p.endTime = o.end;
      const j = await get('BINANCE', '/fapi/v1/klines', p);
      if (!Array.isArray(j)) throw new Error('Binance: ' + (j.msg || 'bad response'));
      return dedupe(j.map((r) => ({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })));
    },
    // 최근 약 30일치만 제공된다.
    async oiHistory(symbol, iv, points) {
      const out = [];
      let end = 0;
      while (out.length < points) {
        const p = { symbol, period: BN_OI[iv], limit: 500 };
        if (end) p.endTime = end;
        const j = await get('BINANCE', '/futures/data/openInterestHist', p);
        if (!Array.isArray(j)) throw new Error('Binance: ' + (j.msg || 'bad response'));
        if (!j.length) break;
        let oldest = Infinity;
        for (const r of j) { out.push({ time: Math.floor(+r.timestamp / 1000), oi: +r.sumOpenInterest }); oldest = Math.min(oldest, +r.timestamp); }
        if (j.length < 500 || oldest - 1 === end) break;
        end = oldest - 1;
      }
      return dedupe(out).slice(-points);
    },
    open(symbol, h) {
      const s = symbol.toLowerCase(), streams = [s + '@forceOrder'];
      if (h.tf) streams.push(s + '@kline_' + BN_TF[h.tf], s + '@ticker', s + '@markPrice@1s');
      const tk = {};
      const ws = new RWS(CFG.BINANCE.ws + '?streams=' + streams.join('/'), {
        onStatus: h.onStatus,
        onMsg: (m) => {
          const d = m.data || m;
          if (!d || !d.e) return;
          if (d.e === 'kline') { const k = d.k; h.onKline({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, confirm: !!k.x }); }
          else if (d.e === 'forceOrder') {
            // 청산 주문 방향 SELL → 롱 포지션이 청산됨
            const o = d.o, price = +o.ap || +o.p;
            h.onLiq({ t: Math.floor(o.T / 1000), price, usd: price * +o.q, side: o.S === 'SELL' ? 'long' : 'short' });
          } else {
            if (d.e === '24hrTicker') { tk.lastPrice = +d.c; tk.price24hPcnt = +d.P / 100; }
            if (d.e === 'markPriceUpdate') { tk.markPrice = +d.p; tk.fundingRate = +d.r; }
            h.onTicker(Object.assign({}, tk));
          }
        },
      });
      return { close: () => ws.close() };
    },
  };

  // ───────── OKX ─────────
  const OKX_TF = { '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1H', '240': '4H', 'D': '1Dutc', 'W': '1Wutc' };
  const OKX_OI = { '5min': '5m', '15min': '15m', '30min': '30m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };
  const okxInst = (symbol) => symbol.replace(/USDT$/, '') + '-USDT-SWAP';
  const ctValCache = {};
  const OKX = {
    id: 'OKX', name: 'OKX', mmr: 0.004,
    async _get(path, p) { const j = await get('OKX', path, p); if (j.code !== '0') throw new Error('OKX ' + j.code + ': ' + j.msg); return j.data || []; },
    // 계약 1장의 기초자산 수량 (예: BTC-USDT-SWAP = 0.01 BTC). 청산 수량 환산에 필요.
    async ctVal(symbol) {
      const id = okxInst(symbol);
      if (!ctValCache[id]) { const d = await this._get('/api/v5/public/instruments', { instType: 'SWAP', instId: id }); ctValCache[id] = +(d[0] && d[0].ctVal) || 0; }
      return ctValCache[id];
    },
    // 최신순으로 페이지당 최대 300개(서버가 더 적게 줄 수 있음), 최근 1,440개까지만 제공
    async klines(symbol, tf, o) {
      o = o || {};
      const want = o.limit || 1000, out = [];
      let after = o.end ? o.end + 1 : 0;
      for (let page = 0; page < 20 && out.length < want; page++) {
        const p = { instId: okxInst(symbol), bar: OKX_TF[tf], limit: 300 };
        if (after) p.after = after;
        const d = await this._get('/api/v5/market/candles', p);
        if (!d.length) break;
        let oldest = Infinity;
        for (const r of d) { out.push({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6] }); oldest = Math.min(oldest, +r[0]); }
        if (oldest === after) break;
        after = oldest;
      }
      return dedupe(out).slice(-want);
    },
    // [ts, oi(계약), oiCcy(기초자산), oiUsd], 페이지당 100개, 최근 1,440개까지만 제공
    async oiHistory(symbol, iv, points) {
      const out = [];
      let end = 0;
      for (let page = 0; page < 20 && out.length < points; page++) {
        const p = { instId: okxInst(symbol), period: OKX_OI[iv], limit: 100 };
        if (end) p.end = end;
        const d = await this._get('/api/v5/rubik/stat/contracts/open-interest-history', p);
        if (!d.length) break;
        let oldest = Infinity;
        for (const r of d) { out.push({ time: Math.floor(+r[0] / 1000), oi: +r[2] }); oldest = Math.min(oldest, +r[0]); }
        if (oldest === end) break;
        end = oldest;
      }
      return dedupe(out).slice(-points);
    },
    open(symbol, h) {
      const inst = okxInst(symbol), socks = [], tk = {};
      let ct = 0;
      this.ctVal(symbol).then((v) => (ct = v)).catch(() => {});
      const args = [{ channel: 'liquidation-orders', instType: 'SWAP' }];
      if (h.tf) args.push({ channel: 'tickers', instId: inst }, { channel: 'mark-price', instId: inst }, { channel: 'funding-rate', instId: inst });
      socks.push(new RWS(CFG.OKX.wsPublic, {
        ping: 'ping', onStatus: h.onStatus,
        onOpen: (send) => send({ op: 'subscribe', args }),
        onMsg: (m) => {
          if (!m.arg || !m.data) return;
          const ch = m.arg.channel;
          if (ch === 'liquidation-orders') {
            for (const d of m.data) {
              if (d.instId !== inst || !ct) continue;
              for (const x of d.details || []) {
                // 헤지 모드는 posSide, 단방향 모드는 주문 방향(sell → 롱 청산)으로 판별
                const side = x.posSide === 'long' ? 'long' : x.posSide === 'short' ? 'short' : x.side === 'sell' ? 'long' : 'short';
                h.onLiq({ t: Math.floor(+x.ts / 1000), price: +x.bkPx, usd: +x.bkPx * +x.sz * ct, side });
              }
            }
            return;
          }
          const d = m.data[0];
          if (ch === 'tickers') { tk.lastPrice = +d.last; if (+d.open24h) tk.price24hPcnt = (+d.last - +d.open24h) / +d.open24h; }
          if (ch === 'mark-price') tk.markPrice = +d.markPx;
          if (ch === 'funding-rate') tk.fundingRate = +d.fundingRate;
          h.onTicker(Object.assign({}, tk));
        },
      }));
      if (h.tf) {
        socks.push(new RWS(CFG.OKX.wsBusiness, {
          ping: 'ping',
          onOpen: (send) => send({ op: 'subscribe', args: [{ channel: 'candle' + OKX_TF[h.tf], instId: inst }] }),
          onMsg: (m) => { if (m.data && m.arg && m.arg.channel.startsWith('candle')) for (const r of m.data) h.onKline({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6], confirm: r[8] === '1' }); },
        }));
      }
      return { close: () => socks.forEach((s) => s.close()) };
    },
  };

  ET.ex = { list: [BYBIT, BINANCE, OKX], BYBIT, BINANCE, OKX, TF_SEC, OI_SEC, OI_TO_TF, TF_TO_OI };
})(typeof window !== 'undefined' ? window : globalThis);
