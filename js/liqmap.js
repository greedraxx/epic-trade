// 추정 청산맵 모델.
// 원리: 미결제약정(OI)이 늘어난 구간 = 신규 포지션 진입. 그 가격을 진입가로 보고
// 레버리지 티어별 청산가를 계산해 가격 구간(bin)에 누적한다. 이후 가격이 그 레벨을
// 지나가면 청산된 것으로 보고 제거하고, OI가 줄면 남은 레벨을 같은 비율로 줄인다.
// 레버리지 분포(가중치)는 공개 데이터가 없으므로 "가정값"이다.
(function (root) {
  const ET = (root.ET = root.ET || {});

  const DEFAULT_TIERS = [
    { lev: 10, w: 0.30 },
    { lev: 25, w: 0.35 },
    { lev: 50, w: 0.25 },
    { lev: 100, w: 0.10 },
  ];

  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const f = x / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * p;
  }

  // 한 거래소의 시뮬레이션. 공용 가격 구간(min/step/n)과 공용 시간축(times) 위에서 돌린다.
  function simulate(src, times, stepSec, min, step, n, tiers, grid) {
    const mmr = src.mmr == null ? 0.005 : src.mmr, nt = tiers.length, T = times.length;
    const byTime = new Map(src.klines.map((c) => [c.time, c]));
    const oiAt = new Map(src.oi.map((r) => [r.time, r.oi]));
    // active[side][tier] = Float64Array(n), side 0=롱 청산(가격 아래), 1=숏 청산(가격 위)
    const active = [0, 1].map(() => tiers.map(() => new Float64Array(n)));
    const binOf = (p) => Math.floor((p - min) / step);
    let used = 0, bars = 0, lastOi = null, lastClose = null;

    for (let k = 0; k < T; k++) {
      const c = byTime.get(times[k]);
      if (c) {
        bars++;
        lastClose = c.close;
        // 1) 이 캔들이 지나간 레벨 제거
        const bl = Math.max(0, binOf(c.low)), bh = Math.min(n - 1, binOf(c.high));
        for (let t = 0; t < nt; t++) {
          const L = active[0][t], S = active[1][t];
          for (let b = bl; b < n; b++) L[b] = 0; // 저가 이상에 있던 롱 청산 레벨은 모두 소멸
          for (let b = 0; b <= bh; b++) S[b] = 0; // 고가 이하에 있던 숏 청산 레벨은 모두 소멸
        }
        // 2) OI 변화 반영
        const a = oiAt.get(c.time), b2 = oiAt.get(c.time + stepSec);
        if (a != null && b2 != null && a > 0) {
          used++;
          lastOi = b2;
          const d = b2 - a;
          if (d < 0) {
            const f = b2 / a;
            for (let s = 0; s < 2; s++) for (let t = 0; t < nt; t++) { const A = active[s][t]; for (let b = 0; b < n; b++) A[b] *= f; }
          } else if (d > 0) {
            const entry = (c.high + c.low + c.close) / 3;
            const usd = d * entry;
            for (let t = 0; t < nt; t++) {
              const { lev, w } = tiers[t];
              const pl = entry * (1 - 1 / lev + mmr), ps = entry * (1 + 1 / lev - mmr);
              const il = binOf(pl), is = binOf(ps);
              if (pl < c.close && il >= 0 && il < n) active[0][t][il] += usd * w;
              if (ps > c.close && is >= 0 && is < n) active[1][t][is] += usd * w;
            }
          }
        }
      }
      // 3) 히트맵 열에 합산 (이 거래소 캔들이 빠진 시각은 직전 상태 유지)
      const off = k * n;
      for (let b = 0; b < n; b++) {
        let v = 0;
        for (let t = 0; t < nt; t++) v += active[0][t][b] + active[1][t][b];
        if (v) grid[off + b] += v;
      }
    }
    let usd = 0;
    for (let s = 0; s < 2; s++) for (let t = 0; t < nt; t++) for (let b = 0; b < n; b++) usd += active[s][t][b];
    return { id: src.id, active, coverage: bars ? used / bars : 0, usd, oiBase: lastOi, oiUsd: lastOi != null && lastClose != null ? lastOi * lastClose : null };
  }

  // sources: [{id, klines, oi, mmr}] — 거래소별 기준 해상도 캔들과 OI 스냅샷(둘 다 오름차순).
  // 거래소마다 따로 시뮬레이션한 뒤 같은 가격 구간에 달러 금액을 그대로 더한다(점유율 가중 없음).
  function computeMulti(sources, opts) {
    opts = opts || {};
    sources = sources.filter((s) => s.klines && s.klines.length >= 3);
    if (!sources.length) return null;
    const tiers = opts.tiers || DEFAULT_TIERS;
    const ref = sources.reduce((a, b) => (b.klines.length > a.klines.length ? b : a));
    const times = ref.klines.map((c) => c.time), T = times.length;
    const stepSec = times[1] - times[0];
    let lo = Infinity, hi = -Infinity;
    for (const s of sources) for (const k of s.klines) { if (k.low < lo) lo = k.low; if (k.high > hi) hi = k.high; }
    const last = ref.klines[T - 1].close;
    const minLev = Math.min.apply(null, tiers.map((t) => t.lev));
    const step = opts.step || niceStep(last * 0.0005);
    const min = Math.floor((lo * (1 - 1 / minLev)) / step) * step;
    const max = Math.ceil((hi * (1 + 1 / minLev)) / step) * step;
    const n = Math.round((max - min) / step), nt = tiers.length;

    const grid = new Float32Array(n * T);
    const per = sources.map((s) => simulate(s, times, stepSec, min, step, n, tiers, grid));
    const active = [0, 1].map(() => tiers.map(() => new Float64Array(n)));
    for (const p of per) for (let s = 0; s < 2; s++) for (let t = 0; t < nt; t++) { const A = active[s][t], B = p.active[s][t]; for (let b = 0; b < n; b++) A[b] += B[b]; }

    // 색상 정규화 기준: 0이 아닌 값의 99.5 퍼센타일
    const sample = [];
    const stride = Math.max(1, Math.floor(grid.length / 200000));
    for (let i = 0; i < grid.length; i += stride) if (grid[i] > 0) sample.push(grid[i]);
    sample.sort((x, y) => x - y);
    const vmax = sample.length ? sample[Math.floor(sample.length * 0.995)] : 1;

    return {
      min, step, n, T, times, stepSec, grid, active, tiers, vmax, last,
      oiCoverage: Math.min.apply(null, per.map((p) => p.coverage)),
      sources: per.map((p) => ({ id: p.id, coverage: p.coverage, usd: p.usd, oiBase: p.oiBase, oiUsd: p.oiUsd })),
    };
  }

  // 단일 거래소용 (klines, oi가 같은 해상도)
  function compute(klines, oi, opts) {
    opts = opts || {};
    return computeMulti([{ id: opts.id || 'SINGLE', klines, oi, mmr: opts.mmr }], opts);
  }

  // 현재 남아 있는 레벨의 가격대별 합계와 누적
  function profile(m, price) {
    const n = m.n, nt = m.tiers.length;
    const long = new Float64Array(n), short = new Float64Array(n);
    for (let t = 0; t < nt; t++) for (let b = 0; b < n; b++) { long[b] += m.active[0][t][b]; short[b] += m.active[1][t][b]; }
    const pb = Math.floor((price - m.min) / m.step);
    const cumLong = new Float64Array(n), cumShort = new Float64Array(n);
    let acc = 0;
    for (let b = Math.min(n - 1, pb); b >= 0; b--) { acc += long[b]; cumLong[b] = acc; }
    const totalLong = acc;
    acc = 0;
    for (let b = Math.max(0, pb); b < n; b++) { acc += short[b]; cumShort[b] = acc; }
    return { long, short, cumLong, cumShort, totalLong, totalShort: acc };
  }

  // 가장 큰 청산 밀집 구간 상위 count개 (3-bin 합 기준 국소 최대)
  function clusters(m, price, count) {
    const p = profile(m, price);
    const out = { long: [], short: [] };
    for (const side of ['long', 'short']) {
      const a = p[side], peaks = [];
      const s3 = (b) => (a[b - 1] || 0) + a[b] + (a[b + 1] || 0);
      for (let b = 0; b < m.n; b++) {
        if (a[b] <= 0) continue;
        const v = s3(b);
        if (a[b] >= (a[b - 1] || 0) && a[b] >= (a[b + 1] || 0)) peaks.push({ price: m.min + (b + 0.5) * m.step, usd: v });
      }
      peaks.sort((x, y) => y.usd - x.usd);
      const picked = [];
      for (const pk of peaks) {
        if (picked.every((q) => Math.abs(q.price - pk.price) > m.step * 4)) picked.push(pk);
        if (picked.length >= (count || 3)) break;
      }
      out[side] = picked.map((q) => ({ price: q.price, usd: q.usd, dist: (q.price - price) / price }));
    }
    out.totalLong = p.totalLong;
    out.totalShort = p.totalShort;
    return out;
  }

  ET.liqmap = { compute, computeMulti, profile, clusters, DEFAULT_TIERS, niceStep };
})(typeof window !== 'undefined' ? window : globalThis);
