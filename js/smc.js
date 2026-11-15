// 스마트 머니 컨셉: 스윙 구조(BOS/CHoCH), 오더블록, FVG, EQH/EQL.
// 모든 판정은 "확정된 봉"만 사용한다(피벗은 len봉 뒤에 확정 → 리페인트 없음).
(function (root) {
  const ET = (root.ET = root.ET || {});

  function atr(c, period) {
    period = period || 14;
    const out = new Float64Array(c.length);
    let prev = 0;
    for (let i = 0; i < c.length; i++) {
      const tr = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
      prev = i < period ? (prev * i + tr) / (i + 1) : (prev * (period - 1) + tr) / period;
      out[i] = prev;
    }
    return out;
  }

  function analyze(c, opts) {
    opts = opts || {};
    const len = opts.len || 5;
    const fvgMinAtr = opts.fvgMinAtr == null ? 0.25 : opts.fvgMinAtr;
    const eqAtr = opts.eqAtr == null ? 0.1 : opts.eqAtr;
    const N = c.length;
    const A = atr(c, 14);
    const swings = [], structures = [], obs = [], fvgs = [], eq = [];
    let lastH = null, lastL = null; // 가장 최근 확정 스윙 (돌파 여부 포함)
    let prevH = null, prevL = null;
    let trend = 0;

    const isPivot = (i, hi) => {
      for (let k = 1; k <= len; k++) {
        if (hi) { if (c[i - k].high >= c[i].high || c[i + k].high > c[i].high) return false; }
        else { if (c[i - k].low <= c[i].low || c[i + k].low < c[i].low) return false; }
      }
      return true;
    };

    for (let j = 0; j < N; j++) {
      // FVG (3봉 갭) — j봉 종가에서 확정
      if (j >= 2) {
        const gapUp = c[j].low - c[j - 2].high, gapDn = c[j - 2].low - c[j].high;
        if (gapUp > fvgMinAtr * A[j] && c[j - 1].close > c[j - 2].high) fvgs.push({ dir: 1, idx: j - 1, top: c[j].low, bottom: c[j - 2].high, endIdx: null });
        if (gapDn > fvgMinAtr * A[j] && c[j - 1].close < c[j - 2].low) fvgs.push({ dir: -1, idx: j - 1, top: c[j - 2].low, bottom: c[j].high, endIdx: null });
      }
      // 피벗 확정 (i = j - len)
      const i = j - len;
      if (i >= len) {
        if (isPivot(i, true)) {
          const s = { idx: i, price: c[i].high, type: 'H', label: lastH ? (c[i].high > lastH.price ? 'HH' : 'LH') : 'H', broken: false };
          if (lastH && Math.abs(lastH.price - s.price) <= eqAtr * A[i]) eq.push({ type: 'EQH', i1: lastH.idx, i2: i, price: Math.max(lastH.price, s.price), endIdx: null });
          prevH = lastH; lastH = s; swings.push(s);
        }
        if (isPivot(i, false)) {
          const s = { idx: i, price: c[i].low, type: 'L', label: lastL ? (c[i].low < lastL.price ? 'LL' : 'HL') : 'L', broken: false };
          if (lastL && Math.abs(lastL.price - s.price) <= eqAtr * A[i]) eq.push({ type: 'EQL', i1: lastL.idx, i2: i, price: Math.min(lastL.price, s.price), endIdx: null });
          prevL = lastL; lastL = s; swings.push(s);
        }
      }
      // 구조 돌파 (종가 기준)
      if (lastH && !lastH.broken && c[j].close > lastH.price) {
        lastH.broken = true;
        structures.push({ type: trend === -1 ? 'CHoCH' : 'BOS', dir: 1, fromIdx: lastH.idx, toIdx: j, price: lastH.price });
        trend = 1;
        let m = lastH.idx; // 돌파를 만든 상승의 기점: 스윙 고점~돌파봉 사이 최저 저가 봉
        for (let k = lastH.idx; k < j; k++) if (c[k].low < c[m].low) m = k;
        obs.push({ dir: 1, idx: m, top: c[m].high, bottom: c[m].low, endIdx: null, createdIdx: j });
      }
      if (lastL && !lastL.broken && c[j].close < lastL.price) {
        lastL.broken = true;
        structures.push({ type: trend === 1 ? 'CHoCH' : 'BOS', dir: -1, fromIdx: lastL.idx, toIdx: j, price: lastL.price });
        trend = -1;
        let m = lastL.idx;
        for (let k = lastL.idx; k < j; k++) if (c[k].high > c[m].high) m = k;
        obs.push({ dir: -1, idx: m, top: c[m].high, bottom: c[m].low, endIdx: null, createdIdx: j });
      }
      // 무효화/소멸 처리
      for (const o of obs) {
        if (o.endIdx != null || j <= o.createdIdx) continue;
        if ((o.dir === 1 && c[j].close < o.bottom) || (o.dir === -1 && c[j].close > o.top)) o.endIdx = j;
      }
      for (const f of fvgs) {
        if (f.endIdx != null || j <= f.idx + 1) continue;
        if ((f.dir === 1 && c[j].low <= f.bottom) || (f.dir === -1 && c[j].high >= f.top)) f.endIdx = j;
      }
      for (const e of eq) {
        if (e.endIdx != null || j <= e.i2 + len) continue;
        if ((e.type === 'EQH' && c[j].high > e.price) || (e.type === 'EQL' && c[j].low < e.price)) e.endIdx = j; // 유동성 스윕
      }
    }

    // 프리미엄/디스카운트 기준 레인지: 최근 스윙 고점/저점
    let range = null;
    if (lastH && lastL) {
      const from = Math.min(lastH.idx, lastL.idx);
      let hi = -Infinity, lo = Infinity;
      for (let k = from; k < N; k++) { if (c[k].high > hi) hi = c[k].high; if (c[k].low < lo) lo = c[k].low; }
      range = { fromIdx: from, high: hi, low: lo, eq: (hi + lo) / 2 };
    }
    return { swings, structures, obs, fvgs, eq, trend, range, atr: A };
  }

  ET.smc = { analyze, atr };
})(typeof window !== 'undefined' ? window : globalThis);
