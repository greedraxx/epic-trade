// Bybit v5 공개 시장 데이터 (REST + WebSocket). API 키 불필요.
(function (root) {
  const ET = (root.ET = root.ET || {});

  // 직접 호출이 CORS 등으로 실패하면 로컬 프록시(server.js)의 /bybit 경로로 재시도한다.
  const REST_BASES = ['https://api.bybit.com', '/bybit'];
  const WS_URL = 'wss://stream.bybit.com/v5/public/linear';
  let baseIdx = 0;

  const TF_SEC = { '1': 60, '3': 180, '5': 300, '15': 900, '30': 1800, '60': 3600, '120': 7200, '240': 14400, 'D': 86400, 'W': 604800 };
  const OI_SEC = { '5min': 300, '15min': 900, '30min': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  const OI_TO_KLINE = { '5min': '5', '15min': '15', '30min': '30', '1h': '60', '4h': '240', '1d': 'D' };
  const TF_TO_OI = { '5': '5min', '15': '15min', '30': '30min', '60': '1h', '240': '4h', 'D': '1d' };

  async function get(path, params) {
    const qs = new URLSearchParams(params).toString();
    let lastErr;
    for (let k = 0; k < REST_BASES.length; k++) {
      const i = (baseIdx + k) % REST_BASES.length;
      try {
        const r = await fetch(REST_BASES[i] + path + '?' + qs);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (j.retCode !== 0) throw new Error('Bybit ' + j.retCode + ': ' + j.retMsg);
        baseIdx = i;
        return j.result;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  // 오름차순 [{time(초), open, high, low, close, volume}]
  async function klines(symbol, interval, opts) {
    opts = opts || {};
    const p = { category: 'linear', symbol, interval, limit: opts.limit || 1000 };
    if (opts.end) p.end = opts.end;
    const res = await get('/v5/market/kline', p);
    return res.list
      .map((r) => ({ time: Math.floor(+r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }))
      .sort((a, b) => a.time - b.time);
  }

  // 오름차순 [{time(초), oi(기초자산 수량)}], 최대 points 개 (페이지당 200)
  async function oiHistory(symbol, intervalTime, points) {
    const out = [];
    let cursor = '';
    while (out.length < points) {
      const p = { category: 'linear', symbol, intervalTime, limit: 200 };
      if (cursor) p.cursor = cursor;
      const res = await get('/v5/market/open-interest', p);
      const list = res.list || [];
      for (const r of list) out.push({ time: Math.floor(+r.timestamp / 1000), oi: +r.openInterest });
      cursor = res.nextPageCursor;
      if (!cursor || list.length < 200) break;
    }
    const seen = new Set();
    return out
      .filter((r) => (seen.has(r.time) ? false : (seen.add(r.time), true)))
      .sort((a, b) => a.time - b.time)
      .slice(-points);
  }

  async function accountRatio(symbol, period) {
    const res = await get('/v5/market/account-ratio', { category: 'linear', symbol, period: period || '1h', limit: 1 });
    const r = (res.list || [])[0];
    return r ? { buy: +r.buyRatio, sell: +r.sellRatio, time: Math.floor(+r.timestamp / 1000) } : null;
  }

  // 자동 재연결 + 20초 ping. handlers: { 'topic': fn(msg) }
  class Stream {
    constructor(onStatus) {
      this.topics = new Map();
      this.onStatus = onStatus || function () {};
      this.closed = false;
      this.retry = 0;
      this._connect();
    }
    _connect() {
      if (this.closed) return;
      this.onStatus('connecting');
      const ws = (this.ws = new WebSocket(WS_URL));
      ws.onopen = () => {
        this.retry = 0;
        this.onStatus('open');
        const args = [...this.topics.keys()];
        if (args.length) ws.send(JSON.stringify({ op: 'subscribe', args }));
        this.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: 'ping' })), 20000);
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        const h = m.topic && this.topics.get(m.topic);
        if (h) h(m);
      };
      ws.onclose = () => {
        clearInterval(this.ping);
        if (this.closed) return;
        this.onStatus('closed');
        setTimeout(() => this._connect(), Math.min(15000, 1000 * Math.pow(2, this.retry++)));
      };
      ws.onerror = () => ws.close();
    }
    set(handlers) {
      const next = new Map(Object.entries(handlers));
      const add = [...next.keys()].filter((t) => !this.topics.has(t));
      const del = [...this.topics.keys()].filter((t) => !next.has(t));
      this.topics = next;
      if (this.ws.readyState === 1) {
        if (del.length) this.ws.send(JSON.stringify({ op: 'unsubscribe', args: del }));
        if (add.length) this.ws.send(JSON.stringify({ op: 'subscribe', args: add }));
      }
    }
    close() { this.closed = true; clearInterval(this.ping); this.ws.close(); }
  }

  ET.data = { klines, oiHistory, accountRatio, Stream, TF_SEC, OI_SEC, OI_TO_KLINE, TF_TO_OI };
})(typeof window !== 'undefined' ? window : globalThis);
