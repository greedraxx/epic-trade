// 단기 방향 점수 + 자체 검증(백테스트).
// 점수는 5개 요인의 단순 평균(동일 가중, 맞춤 조정 없음)이고, 모든 요인은 해당 봉 종가까지의 정보만 쓴다.
// 이 점수가 맞는지는 주장하지 않는다 — 아래 backtest가 불러온 데이터에서 실제 적중률을 잰다.
(function (root) {
  const ET = (root.ET = root.ET || {});
  const clip = (v) => Math.max(-1, Math.min(1, v));
  const FACTORS = [
    ['mom', '모멘텀', '종가와 20봉 지수이동평균의 거리(ATR 단위)'],
    ['struct', '구조', '마지막 BOS/CHoCH 방향'],
    ['flow', '체결 압력', '최근 10봉의 거래량 가중 봉 몸통 방향(주문흐름 근사)'],
    ['oi', 'OI·가격', '가격과 미결제약정이 같이 늘면 추세 지속으로 해석'],
    ['liq', '청산 쏠림', '현재가 ±3% 안의 추정 청산 물량이 더 많은 쪽'],
  ];

  // c: 캔들(마지막 봉은 진행 중일 수 있음). o: {atr, structures, oiAt(time)→값|undefined, liqAsym(i)→값|NaN}
  function factors(c, o) {
    const n = c.length, A = o.atr, f = {};
    for (const [k] of FACTORS) f[k] = new Float64Array(n).fill(NaN);
    // 모멘텀
    let ema = c[0].close;
    for (let i = 0; i < n; i++) { ema += (c[i].close - ema) * (2 / 21); if (i >= 20 && A[i] > 0) f.mom[i] = clip((c[i].close - ema) / A[i] / 2); }
    // 구조: 돌파가 확정된 봉(toIdx)부터 그 방향
    const st = (o.structures || []).slice().sort((a, b) => a.toIdx - b.toIdx);
    let dir = 0, p = 0;
    for (let i = 0; i < n; i++) { while (p < st.length && st[p].toIdx <= i) dir = st[p++].dir; if (dir) f.struct[i] = dir; }
    // 체결 압력
    for (let i = 9; i < n; i++) {
      let num = 0, den = 0;
      for (let k = i - 9; k <= i; k++) { const r = c[k].high - c[k].low; if (r > 0) num += c[k].volume * (c[k].close - c[k].open) / r; den += c[k].volume; }
      if (den > 0) f.flow[i] = clip((num / den) * 2);
    }
    // OI·가격 (6봉 변화)
    if (o.oiAt) for (let i = 6; i < n; i++) {
      const a = o.oiAt(c[i - 6].time), b = o.oiAt(c[i].time);
      if (a == null || b == null) continue;
      const dp = c[i].close - c[i - 6].close;
      f.oi[i] = Math.abs(dp) < 0.25 * A[i] ? 0 : Math.sign(dp) * (b > a ? 1 : 0.3);
    }
    // 청산 쏠림
    if (o.liqAsym) for (let i = 0; i < n; i++) f.liq[i] = o.liqAsym(i);
    const score = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) { let s = 0, m = 0; for (const [k] of FACTORS) if (!isNaN(f[k][i])) { s += f[k][i]; m++; } if (m >= 2) score[i] = s / m; }
    return { f, score };
  }

  // series[i]의 부호를 h봉 뒤 종가 방향 예측으로 보고 적중률을 잰다. |값| < thr 는 신호 없음.
  // end: 평가에 쓸 마지막 봉(진행 중인 봉 제외). fee: 왕복 수수료(비율).
  function evaluate(c, series, h, thr, fee, end) {
    let n = 0, hits = 0, sum = 0, up = 0;
    for (let i = 30; i + h <= end; i++) {
      const s = series[i];
      if (isNaN(s) || Math.abs(s) < thr) continue;
      const r = (c[i + h].close - c[i].close) / c[i].close;
      n++; if (r * s > 0) hits++; if (r > 0) up++;
      sum += r * Math.sign(s);
    }
    if (!n) return { h, n: 0 };
    const pHit = hits / n, nEff = Math.max(1, n / h); // 구간이 겹치므로 유효 표본은 n/h
    const ci = 1.96 * Math.sqrt((pHit * (1 - pHit)) / nEff);
    const net = sum / n - fee;
    return { h, n, nEff: Math.round(nEff), hit: pHit, ci, lo: pHit - ci, base: Math.max(up, n - up) / n, avg: sum / n, net, edge: pHit - ci > 0.5 && net > 0 };
  }

  function analyze(c, o) {
    o = o || {};
    const thr = o.thr == null ? 0.25 : o.thr, fee = o.fee == null ? 0.0011 : o.fee;
    const { f, score } = factors(c, o);
    const end = c.length - 2; // 마지막 봉은 진행 중
    const last = Math.max(0, end);
    const s = score[last];
    return {
      thr, fee, FACTORS,
      now: { score: s, dir: isNaN(s) || Math.abs(s) < thr ? 0 : Math.sign(s), parts: FACTORS.map(([k, name, desc]) => ({ key: k, name, desc, value: f[k][last] })) },
      horizons: [1, 4, 12].map((h) => evaluate(c, score, h, thr, fee, end)),
      perFactor: FACTORS.map(([k, name]) => Object.assign({ key: k, name }, evaluate(c, f[k], 4, thr, fee, end))),
      score, f,
    };
  }

  ET.signal = { analyze, factors, evaluate, FACTORS };
})(typeof window !== 'undefined' ? window : globalThis);
